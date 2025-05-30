import {
  appendClientMessage,
  appendResponseMessages,
  createDataStream,
  smoothStream,
  streamText,
  Message,
} from 'ai';
import { auth, type UserType } from '@/app/(auth)/auth';
import { type RequestHints, systemPrompt } from '@/lib/ai/prompts';
import {
  createStreamId,
  deleteChatById,
  getChatById,
  getMessageCountByUserId,
  getMessagesByChatId,
  getStreamIdsByChatId,
  saveChat,
  saveMessages,
} from '@/lib/db/queries';
import { generateUUID, getTrailingMessageId } from '@/lib/utils';
import { generateTitleFromUserMessage } from '../../actions';
import { createDocument } from '@/lib/ai/tools/create-document';
import { updateDocument } from '@/lib/ai/tools/update-document';
import { requestSuggestions } from '@/lib/ai/tools/request-suggestions';
import { getWeather } from '@/lib/ai/tools/get-weather';
import { isProductionEnvironment } from '@/lib/constants';
import { myProvider } from '@/lib/ai/providers';
import { entitlementsByUserType } from '@/lib/ai/entitlements';
import { postRequestBodySchema, type PostRequestBody } from './schema';
import { geolocation } from '@vercel/functions';
import {
  createResumableStreamContext,
  type ResumableStreamContext,
} from 'resumable-stream';
import { after } from 'next/server';
import type { Chat } from '@/lib/db/schema';
import { differenceInSeconds } from 'date-fns';
import { ChatSDKError } from '@/lib/errors';

export const maxDuration = 60;
let globalStreamContext: ResumableStreamContext | null = null;

function getStreamContext() {
  if (!globalStreamContext) {
    try {
      globalStreamContext = createResumableStreamContext({ waitUntil: after });
    } catch (error: any) {
      if (error.message.includes('REDIS_URL')) {
        console.log(' > Resumable streams are disabled due to missing REDIS_URL');
      } else {
        console.error(error);
      }
    }
  }
  return globalStreamContext;
}

export async function POST(request: Request) {
  let requestBody: PostRequestBody;
  try {
    const json = await request.json();
    requestBody = postRequestBodySchema.parse(json);
  } catch (_) {
    return new ChatSDKError('bad_request:api').toResponse();
  }

  try {
    const { id, message, selectedChatModel, selectedVisibilityType } = requestBody;
    const session = await auth();
    if (!session?.user) return new ChatSDKError('unauthorized:chat').toResponse();

    const userType: UserType = session.user.type;
    const messageCount = await getMessageCountByUserId({ id: session.user.id, differenceInHours: 24 });
    if (messageCount > entitlementsByUserType[userType].maxMessagesPerDay) {
      return new ChatSDKError('rate_limit:chat').toResponse();
    }

    const chat = await getChatById({ id });
    if (!chat) {
      const title = await generateTitleFromUserMessage({ message });
      await saveChat({ id, userId: session.user.id, title, visibility: selectedVisibilityType });
    } else if (chat.userId !== session.user.id) {
      return new ChatSDKError('forbidden:chat').toResponse();
    }

    // Convert DB messages to UI Message[]
    const rawMessages = await getMessagesByChatId({ id });
    const uiMessages: Message[] = rawMessages.map((m) => {
      const roles: Message['role'][] = ['user', 'assistant', 'system', 'data'];
      const role = roles.includes(m.role as Message['role']) ? (m.role as Message['role']) : 'user';
      return {
        id: m.id,
        role,
        content: Array.isArray(m.parts) ? m.parts.join('') : String(m.parts),
        attachments: Array.isArray(m.attachments) ? m.attachments : [],
      };
    });
    const messages = appendClientMessage({ messages: uiMessages, message });

    const { longitude, latitude, city, country } = geolocation(request);
    const requestHints: RequestHints = { longitude, latitude, city, country };

    await saveMessages({ messages: [{ id: message.id, chatId: id, role: 'user', parts: message.parts, attachments: message.experimental_attachments ?? [], createdAt: new Date() }] });

    const streamId = generateUUID();
    await createStreamId({ streamId, chatId: id });

    // Build combined system prompt
    const manualText =
      'Zachary Edelstein is an AI and Analytics Consultant with over eight years of experience transforming complex data into actionable insights—leading AI and analytics initiatives across media, utilities, real estate, financial services, and higher education as an independent consultant by designing ML‑driven Tableau and Power BI dashboards, optimizing ETL pipelines, and deploying predictive models for clients like Exelon and the University of Phoenix; as Director of Insights & Analytics at Ziff Davis he developed proprietary AI‑powered analytics tools, built a scalable AI content‑generation engine, provided CEO‑level insights for nine‑figure M&A assessments, and managed enterprise dashboard ecosystems and cloud‑based model deployments; previously at Stella Rising he onboarded Tableau and Salesforce Datorama, built flexible marketing data models, and delivered strategic insights; at Universal Health Services he spearheaded SEO and UX improvements through A/B testing and executive reporting; at Majux Marketing he integrated analytics into SEO, PPC, and creative workflows with multivariate testing; and at Gen3 Marketing he originated the firm’s Technical SEO Analyst role and established conversion‑rate optimization, information‑architecture design, and analytics processes—all underpinned by expertise in Python (Pandas, Scikit‑learn, TensorFlow), R, Vertex AI, AWS SageMaker, marketing mix modeling, multi‑touch attribution, predictive modeling, NLP, SQL, BigQuery, Snowflake, AWS, GCP, Google Tag Manager, JavaScript, Tableau, Power BI, Looker Studio, Matplotlib, stakeholder engagement, cross‑functional collaboration, strategic roadmapping, and project management, and supported by a BA in Political Economy from NYU and a Google Project Manager Certification. Outside of work, zachs hobbies include playing guitar, spending time with his dog murph, photography and exploring film history.';
    const baseSystem = systemPrompt({ selectedChatModel, requestHints });
    const combinedSystem = `${baseSystem}\n${manualText}`;

    const stream = createDataStream({
      execute: (dataStream) => {
        const result = streamText({
          model: myProvider.languageModel(selectedChatModel),
          system: combinedSystem,
          messages,
          maxSteps: 5,
          experimental_activeTools:
            selectedChatModel === 'chat-model-reasoning'
              ? []
              : ['getWeather', 'createDocument', 'updateDocument', 'requestSuggestions'],
          experimental_transform: smoothStream({ chunking: 'word' }),
          experimental_generateMessageId: generateUUID,
          tools: {
            getWeather,
            createDocument: createDocument({ session, dataStream }),
            updateDocument: updateDocument({ session, dataStream }),
            requestSuggestions: requestSuggestions({ session, dataStream }),
          },
          onFinish: async ({ response }) => {
            if (!session.user?.id) return;
            try {
              const assistantId = getTrailingMessageId({ messages: response.messages.filter((m) => m.role === 'assistant') });
              if (!assistantId) throw new Error('No assistant message found!');
              const [, assistantMsg] = appendResponseMessages({ messages: [message], responseMessages: response.messages });
              await saveMessages({ messages: [{ id: assistantId, chatId: id, role: assistantMsg.role, parts: assistantMsg.parts, attachments: assistantMsg.experimental_attachments ?? [], createdAt: new Date() }] });
            } catch {
              console.error('Failed to save chat');
            }
          },
          experimental_telemetry: { isEnabled: isProductionEnvironment, functionId: 'stream-text' },
        });
        result.consumeStream();
        result.mergeIntoDataStream(dataStream, { sendReasoning: true });
      },
      onError: () => 'Oops, an error occurred!',
    });

    const streamContext = getStreamContext();
    if (streamContext) {
      return new Response(await streamContext.resumableStream(streamId, () => stream));
    }
    return new Response(stream);
  } catch (error) {
    if (error instanceof ChatSDKError) return error.toResponse();
  }
}

export async function GET(request: Request) {
  const streamContext = getStreamContext();
  const resumeRequestedAt = new Date();
  if (!streamContext) return new Response(null, { status: 204 });

  const { searchParams } = new URL(request.url);
  const chatId = searchParams.get('chatId');
  if (!chatId) return new ChatSDKError('bad_request:api').toResponse();

  const session = await auth();
  if (!session?.user) return new ChatSDKError('unauthorized:chat').toResponse();

  let chat: Chat;
  try { chat = await getChatById({ id: chatId }); } catch { return new ChatSDKError('not_found:chat').toResponse(); }
  if (!chat) return new ChatSDKError('not_found:chat').toResponse();
  if (chat.visibility === 'private' && chat.userId !== session.user.id) return new ChatSDKError('forbidden:chat').toResponse();

  const streamIds = await getStreamIdsByChatId({ chatId });
  if (!streamIds.length) return new ChatSDKError('not_found:stream').toResponse();
  const recentId = streamIds.at(-1)!;

  const emptyDataStream = createDataStream({ execute: () => {} });
  const resumed = await streamContext.resumableStream(recentId, () => emptyDataStream);

  if (!resumed) {
    const msgs = await getMessagesByChatId({ id: chatId });
    const lastMsg = msgs.at(-1);
    if (!lastMsg || lastMsg.role !== 'assistant') return new Response(emptyDataStream, { status: 200 });
    const ageSec = differenceInSeconds(resumeRequestedAt, new Date(lastMsg.createdAt));
    if (ageSec > 15) return new Response(emptyDataStream, { status: 200 });
    const restored = createDataStream({ execute: (buffer) => buffer.writeData({ type: 'append-message', message: JSON.stringify(lastMsg) }) });
    return new Response(restored, { status: 200 });
  }
  return new Response(resumed, { status: 200 });
}

export async function DELETE(request: Request) {
  const { searchParams } = new URL(request.url);
  const id = searchParams.get('id');
  if (!id) return new ChatSDKError('bad_request:api').toResponse();
  const session = await auth();
  if (!session?.user) return new ChatSDKError('unauthorized:chat').toResponse();
  const chat = await getChatById({ id });
  if (chat.userId !== session.user.id) return new ChatSDKError('forbidden:chat').toResponse();
  const deleted = await deleteChatById({ id });
  return Response.json(deleted, { status: 200 });
}
