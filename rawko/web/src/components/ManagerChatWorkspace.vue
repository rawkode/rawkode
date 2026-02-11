<script setup lang="ts">
import {
  AvatarFallback,
  AvatarRoot,
} from '@ark-ui/vue/avatar';
import {
  FieldHelperText,
  FieldLabel,
  FieldRoot,
  FieldTextarea,
} from '@ark-ui/vue/field';
import {
  SwitchControl,
  SwitchHiddenInput,
  SwitchLabel,
  SwitchRoot,
  SwitchThumb,
} from '@ark-ui/vue/switch';
import {
  TabContent,
  TabIndicator,
  TabList,
  TabTrigger,
  TabsRoot,
} from '@ark-ui/vue/tabs';
import { css, cx } from '../../styled-system/css';
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';

type ChatRole = 'user' | 'manager' | 'system';

interface ChatMessage {
  id: string;
  role: ChatRole;
  text: string;
  at: string;
  stamp: number;
}

interface RuntimeActiveTask {
  id: string;
  agentId: string;
  agentName: string;
  task: string;
  state: 'running' | 'waiting_review';
  startedAt: string;
}

interface RuntimeRecentTask {
  id: string;
  title: string;
  by: string;
  completedAt: string;
}

interface RuntimeOffSickAgent {
  agentId: string;
  agentName: string;
  reason: string;
  at: string;
}

interface RuntimeSnapshot {
  completed: boolean;
  cycle: number;
  activeTasks: RuntimeActiveTask[];
  recentTasks: RuntimeRecentTask[];
  offSick: RuntimeOffSickAgent[];
  agentStates: Record<string, string>;
}

interface AgentTask {
  id: string;
  agent: string;
  title: string;
  state: string;
  runningFor: string;
  startedAt: string;
}

interface BlockedTask {
  id: string;
  agent: string;
  issue: string;
  since: string;
}

interface RecentTaskCard {
  id: string;
  title: string;
  by: string;
  completedAt: string;
}

interface RuntimeEventEnvelope {
  seq: number;
  time: string;
  event: Record<string, unknown> & { type: string };
}

const runtimeBaseUrl = (
  (import.meta.env.PUBLIC_RUNTIME_URL as string | undefined) ??
  'http://127.0.0.1:8788'
).trim().replace(/\/+$/, '');

const messages = ref<ChatMessage[]>([]);
const draft = ref('');
const sending = ref(false);
const stickyScroll = ref(true);
const taskView = ref<'active' | 'blocked' | 'recent'>('active');
const chatFeedEl = ref<HTMLElement | null>(null);
const runtimeOnline = ref(false);
const runtimeError = ref<string | null>(null);
const lastFailureByAgent = ref<Record<string, string>>({});

const snapshot = ref<RuntimeSnapshot>({
  completed: false,
  cycle: 0,
  activeTasks: [],
  recentTasks: [],
  offSick: [],
  agentStates: {},
});

let eventSource: EventSource | null = null;
let reconnectTimer: number | null = null;
let snapshotPollTimer: number | null = null;
let snapshotRefreshTimer: number | null = null;
let clockTimer: number | null = null;
let lastEventSeq = 0;

appendMessage('manager', 'Manager channel online. Send any request and I will coordinate it.');

const nowTick = ref(Date.now());

const activeTasks = computed<AgentTask[]>(() => {
  const now = nowTick.value;
  return snapshot.value.activeTasks.map((task) => ({
    id: task.id,
    agent: task.agentName,
    title: task.task,
    state: task.state === 'waiting_review' ? 'WAITING_REVIEW' : 'RUNNING',
    runningFor: formatElapsed(task.startedAt, now),
    startedAt: formatRelative(task.startedAt),
  }));
});

const blockedTasks = computed<BlockedTask[]>(() =>
  snapshot.value.offSick.map((agent) => ({
    id: agent.agentId,
    agent: agent.agentName,
    issue: lastFailureByAgent.value[agent.agentId] ?? agent.reason,
    since: formatRelative(agent.at),
  })),
);

const recentTasks = computed<RecentTaskCard[]>(() =>
  snapshot.value.recentTasks.map((task) => ({
    id: task.id,
    title: task.title,
    by: task.by,
    completedAt: formatRelative(task.completedAt),
  })),
);

const activeCount = computed(() => activeTasks.value.length);
const workspaceSummary = computed(() =>
  activeCount.value > 0
    ? 'Manager chat stays live while background tasks continue.'
    : 'Each message can become its own objective; multiple objectives can run concurrently.',
);
const runtimeStateText = computed(() => (runtimeOnline.value ? 'connected' : 'offline'));
const managerThinking = computed(() => {
  const direct = snapshot.value.agentStates['manager'];
  if (direct === 'manager_thinking') {
    return true;
  }
  return Object.values(snapshot.value.agentStates).some((state) => state === 'manager_thinking');
});
const managerSpinnerGlyph = computed(() => {
  const frames = ['|', '/', '-', '\\'];
  return frames[Math.floor(nowTick.value / 120) % frames.length];
});
const managerThinkingText = computed(() => {
  if (!managerThinking.value) {
    return '';
  }
  return 'Manager is thinking...';
});
const latestUserMessageId = computed<string | null>(() => {
  for (let i = messages.value.length - 1; i >= 0; i -= 1) {
    if (messages.value[i]?.role === 'user') {
      return messages.value[i].id;
    }
  }
  return null;
});
const canSend = computed(() => draft.value.trim().length > 0 && !sending.value);

const runtimeBadgeClass = computed(() =>
  css({
    fontSize: 'xs',
    fontWeight: 'bold',
    color: runtimeOnline.value ? '#065f46' : '#991b1b',
    background: runtimeOnline.value ? '#d1fae5' : '#fee2e2',
    borderRadius: 'full',
    px: '2',
    py: '1',
    textTransform: 'uppercase',
    letterSpacing: '0.04em',
  }),
);

function runtimeUrl(path: string): string {
  return `${runtimeBaseUrl}${path}`;
}

function appendMessage(role: ChatRole, text: string, stamp = Date.now()): void {
  const normalized = text.trim();
  if (!normalized) {
    return;
  }

  const last = messages.value[messages.value.length - 1];
  if (
    last &&
    last.role === role &&
    last.text === normalized &&
    Math.abs(last.stamp - stamp) < 5_000
  ) {
    return;
  }

  messages.value.push({
    id: `${stamp}-${crypto.randomUUID()}`,
    role,
    text: normalized,
    at: new Date(stamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
    stamp,
  });
}

function roleLabel(role: ChatRole): string {
  if (role === 'manager') {
    return 'Manager';
  }
  if (role === 'user') {
    return 'You';
  }
  return 'Runtime';
}

function roleAvatar(role: ChatRole): string {
  if (role === 'manager') {
    return 'M';
  }
  if (role === 'user') {
    return 'U';
  }
  return 'S';
}

function formatRelative(iso: string): string {
  const stamp = Date.parse(iso);
  if (!Number.isFinite(stamp)) {
    return 'just now';
  }

  const diff = Date.now() - stamp;
  const seconds = Math.floor(diff / 1000);
  if (seconds < 45) {
    return 'just now';
  }
  if (seconds < 3600) {
    const mins = Math.floor(seconds / 60);
    return `${mins}m ago`;
  }
  if (seconds < 86_400) {
    const hours = Math.floor(seconds / 3600);
    return `${hours}h ago`;
  }

  const days = Math.floor(seconds / 86_400);
  return `${days}d ago`;
}

function formatElapsed(iso: string, nowMs: number): string {
  const started = Date.parse(iso);
  if (!Number.isFinite(started)) {
    return 'unknown';
  }

  const elapsedMs = Math.max(0, nowMs - started);
  const totalSeconds = Math.floor(elapsedMs / 1000);
  const seconds = totalSeconds % 60;
  const totalMinutes = Math.floor(totalSeconds / 60);
  const minutes = totalMinutes % 60;
  const hours = Math.floor(totalMinutes / 60);

  if (hours > 0) {
    return `${hours}h ${minutes}m`;
  }
  if (minutes > 0) {
    return `${minutes}m ${seconds}s`;
  }
  return `${seconds}s`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function parseRuntimeSnapshot(payload: unknown): RuntimeSnapshot {
  const raw = isRecord(payload) ? payload : {};

  const activeRaw = Array.isArray(raw.activeTasks) ? raw.activeTasks : [];
  const activeTasks = activeRaw
    .filter(isRecord)
    .map((task): RuntimeActiveTask => ({
      id: String(task.id ?? crypto.randomUUID()),
      agentId: String(task.agentId ?? ''),
      agentName: String(task.agentName ?? 'unknown'),
      task: String(task.task ?? ''),
      state: task.state === 'waiting_review' ? 'waiting_review' : 'running',
      startedAt:
        typeof task.startedAt === 'string'
          ? task.startedAt
          : typeof task.updatedAt === 'string'
          ? task.updatedAt
          : new Date().toISOString(),
    }));

  const recentRaw = Array.isArray(raw.recentTasks) ? raw.recentTasks : [];
  const recentTasks = recentRaw
    .filter(isRecord)
    .map((task): RuntimeRecentTask => ({
      id: String(task.id ?? crypto.randomUUID()),
      title: String(task.title ?? ''),
      by: String(task.by ?? 'unknown'),
      completedAt:
        typeof task.completedAt === 'string' ? task.completedAt : new Date().toISOString(),
    }));

  const offSickRaw = Array.isArray(raw.offSick) ? raw.offSick : [];
  const offSick = offSickRaw
    .filter(isRecord)
    .map((agent): RuntimeOffSickAgent => ({
      agentId: String(agent.agentId ?? ''),
      agentName: String(agent.agentName ?? 'unknown'),
      reason: String(agent.reason ?? 'unavailable'),
      at: typeof agent.at === 'string' ? agent.at : new Date().toISOString(),
    }));

  const stateMapRaw = isRecord(raw.agentStates) ? raw.agentStates : {};
  const agentStates: Record<string, string> = {};
  for (const [id, value] of Object.entries(stateMapRaw)) {
    agentStates[id] = String(value ?? 'idle');
  }

  return {
    completed: raw.completed === true,
    cycle: Number.isFinite(Number(raw.cycle)) ? Number(raw.cycle) : 0,
    activeTasks,
    recentTasks,
    offSick,
    agentStates,
  };
}

async function refreshSnapshot(): Promise<void> {
  try {
    const response = await fetch(runtimeUrl('/api/runtime/state'));
    if (!response.ok) {
      throw new Error(`runtime state request failed (${response.status})`);
    }

    const payload = await response.json();
    snapshot.value = parseRuntimeSnapshot(payload);
    runtimeOnline.value = true;
    runtimeError.value = null;
  } catch (error) {
    runtimeOnline.value = false;
    runtimeError.value = `Runtime unavailable: ${stringifyError(error)}`;
  }
}

function scheduleSnapshotRefresh(): void {
  if (snapshotRefreshTimer !== null) {
    return;
  }

  snapshotRefreshTimer = window.setTimeout(() => {
    snapshotRefreshTimer = null;
    void refreshSnapshot();
  }, 180);
}

async function sendMessage(): Promise<void> {
  const text = draft.value.trim();
  if (!text || sending.value) {
    return;
  }

  sending.value = true;
  appendMessage('user', text);

  try {
    const response = await fetch(runtimeUrl('/api/runtime/message'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text }),
    });

    if (!response.ok) {
      throw new Error(await errorFromResponse(response));
    }

    draft.value = '';
    runtimeError.value = null;
    scheduleSnapshotRefresh();
  } catch (error) {
    appendMessage('system', `Message send failed: ${stringifyError(error)}`);
  } finally {
    sending.value = false;
  }
}

function openEventStream(): void {
  closeEventStream();

  const streamUrl = new URL(runtimeUrl('/api/runtime/events'));
  if (lastEventSeq > 0) {
    streamUrl.searchParams.set('offset', String(lastEventSeq));
  }

  const source = new EventSource(streamUrl.toString());
  source.addEventListener('runtime', (message) => {
    const payload = (message as MessageEvent<string>).data;
    handleRuntimeEnvelope(payload);
  });

  source.onopen = () => {
    runtimeOnline.value = true;
    runtimeError.value = null;
  };

  source.onerror = () => {
    runtimeOnline.value = false;
    runtimeError.value = 'Runtime event stream disconnected; retrying...';

    if (eventSource === source) {
      closeEventStream();
      scheduleReconnect();
    }
  };

  eventSource = source;
}

function closeEventStream(): void {
  if (eventSource) {
    eventSource.close();
    eventSource = null;
  }
}

function scheduleReconnect(): void {
  if (reconnectTimer !== null) {
    return;
  }

  reconnectTimer = window.setTimeout(() => {
    reconnectTimer = null;
    void refreshSnapshot();
    openEventStream();
  }, 1500);
}

function handleRuntimeEnvelope(raw: string): void {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return;
  }

  if (!isRecord(parsed) || !isRecord(parsed.event)) {
    return;
  }

  const seq = Number(parsed.seq);
  if (!Number.isFinite(seq)) {
    return;
  }

  const envelope: RuntimeEventEnvelope = {
    seq,
    time: typeof parsed.time === 'string' ? parsed.time : new Date().toISOString(),
    event: {
      ...parsed.event,
      type: String(parsed.event.type ?? ''),
    },
  };

  if (!envelope.event.type) {
    return;
  }

  lastEventSeq = Math.max(lastEventSeq, envelope.seq);
  const eventStamp = Date.parse(envelope.time);
  const stamp = Number.isFinite(eventStamp) ? eventStamp : Date.now();

  switch (envelope.event.type) {
    case 'chat': {
      const roleRaw = envelope.event.role;
      const role: ChatRole =
        roleRaw === 'manager' || roleRaw === 'user' || roleRaw === 'system' ? roleRaw : 'system';
      const text = typeof envelope.event.text === 'string' ? envelope.event.text : '';
      appendMessage(role, text, stamp);
      break;
    }
    case 'completion': {
      scheduleSnapshotRefresh();
      break;
    }
    case 'invoke_failure': {
      const agentId = typeof envelope.event.agentId === 'string' ? envelope.event.agentId : '';
      const reason = typeof envelope.event.reason === 'string' ? envelope.event.reason : '';
      if (agentId && reason) {
        lastFailureByAgent.value = {
          ...lastFailureByAgent.value,
          [agentId]: reason,
        };
      }
      scheduleSnapshotRefresh();
      break;
    }
    case 'agent_state': {
      if (
        envelope.event.state === 'off_sick' &&
        typeof envelope.event.agentId === 'string' &&
        typeof envelope.event.detail === 'string'
      ) {
        lastFailureByAgent.value = {
          ...lastFailureByAgent.value,
          [envelope.event.agentId]: envelope.event.detail,
        };
      }
      scheduleSnapshotRefresh();
      break;
    }
    default:
      scheduleSnapshotRefresh();
      break;
  }
}

async function errorFromResponse(response: Response): Promise<string> {
  try {
    const payload = await response.json();
    if (isRecord(payload) && typeof payload.error === 'string') {
      return payload.error;
    }
  } catch {
    // ignore parsing failures
  }
  return `runtime request failed (${response.status})`;
}

function stringifyError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === 'string') {
    return error;
  }
  return 'unknown error';
}

watch(
  () => messages.value.length,
  async () => {
    if (!stickyScroll.value) {
      return;
    }

    await nextTick();
    if (chatFeedEl.value) {
      chatFeedEl.value.scrollTop = chatFeedEl.value.scrollHeight;
    }
  },
  { immediate: true },
);

onMounted(async () => {
  appendMessage('system', `Connecting to runtime at ${runtimeBaseUrl}...`);
  await refreshSnapshot();
  openEventStream();

  snapshotPollTimer = window.setInterval(() => {
    void refreshSnapshot();
  }, 5_000);

  clockTimer = window.setInterval(() => {
    nowTick.value = Date.now();
  }, 1_000);
});

onBeforeUnmount(() => {
  closeEventStream();

  if (reconnectTimer !== null) {
    window.clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }

  if (snapshotPollTimer !== null) {
    window.clearInterval(snapshotPollTimer);
    snapshotPollTimer = null;
  }

  if (snapshotRefreshTimer !== null) {
    window.clearTimeout(snapshotRefreshTimer);
    snapshotRefreshTimer = null;
  }

  if (clockTimer !== null) {
    window.clearInterval(clockTimer);
    clockTimer = null;
  }
});

const pageClass = css({
  width: '100%',
  minHeight: '100vh',
  px: { base: '4', lg: '8' },
  py: { base: '4', lg: '8' },
});

const shellClass = css({
  maxW: '1400px',
  marginInline: 'auto',
  display: 'grid',
  gap: '5',
});

const headerClass = css({
  background: 'rgba(255, 255, 255, 0.82)',
  border: '1px solid #d1d5db',
  borderRadius: 'xl',
  p: { base: '4', lg: '6' },
  display: 'flex',
  flexDirection: { base: 'column', md: 'row' },
  alignItems: { base: 'flex-start', md: 'center' },
  justifyContent: 'space-between',
  gap: '4',
  backdropFilter: 'blur(6px)',
  animation: 'riseIn 360ms ease-out both',
});

const workspaceClass = css({
  display: 'grid',
  gap: '5',
  gridTemplateColumns: { base: '1fr', lg: 'minmax(0, 2fr) minmax(320px, 1fr)' },
  alignItems: 'start',
});

const panelClass = css({
  background: '#fff',
  border: '1px solid #d1d5db',
  borderRadius: 'xl',
  boxShadow: '0 12px 40px rgba(15, 23, 42, 0.06)',
  animation: 'riseIn 420ms ease-out both',
});

const messageRowClass = css({
  display: 'flex',
  alignItems: 'flex-start',
  gap: '3',
});

const messageUserClass = css({
  justifyContent: 'flex-end',
  flexDirection: 'row-reverse',
});

const bubbleClass = css({
  borderRadius: 'lg',
  px: '3.5',
  py: '2.5',
  fontSize: 'sm',
  lineHeight: '1.45',
  maxW: '65ch',
  whiteSpace: 'pre-wrap',
  animation: 'riseIn 180ms ease-out both',
});

const bubbleManagerClass = css({
  background: '#f9fafb',
  border: '1px solid #e5e7eb',
  color: '#111827',
});

const bubbleUserClass = css({
  background: '#0f766e',
  color: '#f0fdfa',
  border: '1px solid #0f766e',
});

const bubbleSystemClass = css({
  background: '#eff6ff',
  border: '1px solid #bfdbfe',
  color: '#1e3a8a',
});

const tabsListClass = css({
  display: 'grid',
  gridTemplateColumns: 'repeat(3, minmax(0, 1fr))',
  gap: '2',
  p: '1',
  borderRadius: 'lg',
  background: '#f3f4f6',
  border: '1px solid #e5e7eb',
  position: 'relative',
});

const tabTriggerClass = css({
  borderRadius: 'md',
  border: 'none',
  background: 'transparent',
  px: '2.5',
  py: '1.5',
  fontSize: 'xs',
  fontWeight: 'semibold',
  color: '#374151',
  cursor: 'pointer',
  _focusVisible: {
    outline: '2px solid #14b8a6',
    outlineOffset: '2px',
  },
  _selected: {
    color: '#0f172a',
  },
});

const tabsIndicatorClass = css({
  height: 'calc(100% - 8px)',
  top: '4px',
  borderRadius: 'md',
  background: '#ffffff',
  border: '1px solid #d1d5db',
  boxShadow: '0 1px 4px rgba(15, 23, 42, 0.08)',
});

function messageRow(role: ChatRole) {
  return role === 'user' ? cx(messageRowClass, messageUserClass) : messageRowClass;
}

function bubble(role: ChatRole) {
  if (role === 'user') {
    return cx(bubbleClass, bubbleUserClass);
  }
  if (role === 'system') {
    return cx(bubbleClass, bubbleSystemClass);
  }
  return cx(bubbleClass, bubbleManagerClass);
}

function statusPill(state: string) {
  if (state === 'WAITING_REVIEW') {
    return css({
      background: '#fef3c7',
      color: '#92400e',
      borderRadius: 'full',
      px: '2',
      py: '0.5',
      fontSize: 'xs',
      fontWeight: 'semibold',
    });
  }

  return css({
    background: '#ccfbf1',
    color: '#0f766e',
    borderRadius: 'full',
    px: '2',
    py: '0.5',
    fontSize: 'xs',
    fontWeight: 'semibold',
  });
}

</script>

<template>
  <main :class="pageClass">
    <div :class="shellClass">
      <header :class="headerClass">
        <div>
          <p
            :class="
              css({
                fontSize: 'xs',
                fontWeight: 'bold',
                textTransform: 'uppercase',
                letterSpacing: '0.08em',
                color: '#0f766e',
                mb: '2',
              })
            "
          >
            Rawko Manager Console
          </p>
          <h1 :class="css({ margin: 0, fontSize: { base: '2xl', lg: '3xl' }, lineHeight: 1.1, color: '#0f172a' })">
            Always-On Manager Chat
          </h1>
          <p :class="css({ margin: 0, mt: '2', fontSize: 'sm', color: '#475569' })">
            {{ workspaceSummary }}
          </p>
        </div>

        <div :class="css({ display: 'grid', gap: '3', minW: { md: '320px' } })">
          <p :class="css({ margin: 0, fontSize: 'sm', color: '#475569', textAlign: { md: 'right' } })">
            <span :class="css({ fontWeight: 'bold', color: '#0f172a' })">{{ activeCount }}</span>
            active tasks · cycle
            <span :class="css({ fontWeight: 'bold', color: '#0f172a' })">{{ snapshot.cycle }}</span>
          </p>

          <p :class="css({ margin: 0, fontSize: 'xs', color: '#64748b', textAlign: { md: 'right' } })">
            Runtime:
            <code>{{ runtimeBaseUrl }}</code>
          </p>

          <SwitchRoot
            v-model:checked="stickyScroll"
            :class="css({ display: 'inline-flex', alignItems: 'center', gap: '2', justifySelf: { md: 'end' } })"
          >
            <SwitchLabel :class="css({ fontSize: 'xs', color: '#334155', fontWeight: 'semibold' })">Auto-scroll chat</SwitchLabel>
            <SwitchControl
              :class="
                css({
                  width: '10',
                  height: '6',
                  borderRadius: 'full',
                  border: '1px solid #0f766e',
                  background: stickyScroll ? '#0f766e' : '#d1d5db',
                  p: '0.5',
                  display: 'inline-flex',
                  alignItems: 'center',
                  transitionProperty: 'background',
                })
              "
            >
              <SwitchThumb
                :class="
                  css({
                    width: '4',
                    height: '4',
                    borderRadius: 'full',
                    background: '#fff',
                    transform: stickyScroll ? 'translateX(16px)' : 'translateX(0)',
                    transitionProperty: 'transform',
                    transitionDuration: '150ms',
                  })
                "
              />
            </SwitchControl>
            <SwitchHiddenInput />
          </SwitchRoot>
        </div>
      </header>

      <section :class="workspaceClass">
        <article
          :class="
            cx(
              panelClass,
              css({
                minHeight: { base: '68vh', lg: '74vh' },
                display: 'flex',
                flexDirection: 'column',
                overflow: 'hidden',
              }),
            )
          "
        >
          <div
            :class="
              css({
                px: { base: '4', lg: '5' },
                py: '4',
                borderBottom: '1px solid #e5e7eb',
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
              })
            "
          >
            <h2 :class="css({ margin: 0, fontSize: 'lg', color: '#0f172a' })">Manager Channel</h2>
            <div :class="css({ display: 'grid', justifyItems: 'end', gap: '1' })">
              <span :class="runtimeBadgeClass">
                {{ runtimeStateText }}
              </span>
            </div>
          </div>

          <div
            ref="chatFeedEl"
            :class="
              css({
                flex: '1',
                overflowY: 'auto',
                p: { base: '4', lg: '5' },
                display: 'grid',
                gap: '3',
                alignContent: 'start',
                background: '#fcfcfd',
              })
            "
          >
            <p
              v-if="messages.length === 0"
              :class="css({ margin: 0, fontSize: 'sm', color: '#64748b' })"
            >
              Waiting for runtime chat events...
            </p>

            <div v-for="message in messages" :key="message.id" :class="messageRow(message.role)">
              <AvatarRoot
                :class="
                  css({
                    width: '8',
                    height: '8',
                    borderRadius: 'full',
                    border:
                      message.role === 'manager'
                        ? '1px solid #cbd5e1'
                        : message.role === 'user'
                        ? '1px solid #0f766e'
                        : '1px solid #bfdbfe',
                    background:
                      message.role === 'manager'
                        ? '#fff'
                        : message.role === 'user'
                        ? '#0f766e'
                        : '#eff6ff',
                    color:
                      message.role === 'manager'
                        ? '#334155'
                        : message.role === 'user'
                        ? '#e6fffa'
                        : '#1e3a8a',
                    display: 'inline-flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    fontSize: 'xs',
                    fontWeight: 'bold',
                    flexShrink: 0,
                  })
                "
              >
                <AvatarFallback>{{ roleAvatar(message.role) }}</AvatarFallback>
              </AvatarRoot>

              <div :class="css({ display: 'grid', gap: '1', maxW: '70ch' })">
                <p
                  :class="
                    css({
                      margin: 0,
                      fontSize: 'xs',
                      color: '#64748b',
                      textAlign: message.role === 'user' ? 'right' : 'left',
                    })
                  "
                >
                  {{ roleLabel(message.role) }}
                  ·
                  {{ message.at }}
                </p>
                <p :class="bubble(message.role)">
                  {{ message.text }}
                </p>
                <p
                  v-if="
                    managerThinking &&
                    message.role === 'user' &&
                    latestUserMessageId === message.id
                  "
                  :class="
                    css({
                      margin: 0,
                      mt: '1',
                      fontSize: 'xs',
                      fontWeight: 'semibold',
                      color: '#0f766e',
                      display: 'inline-flex',
                      gap: '1.5',
                      alignItems: 'center',
                      justifySelf: 'end',
                    })
                  "
                >
                  <span :class="css({ fontFamily: 'mono', color: '#0f766e' })">{{ managerSpinnerGlyph }}</span>
                  <span>{{ managerThinkingText }}</span>
                </p>
              </div>
            </div>
          </div>

          <form
            :class="
              css({
                p: { base: '4', lg: '5' },
                borderTop: '1px solid #e5e7eb',
                display: 'grid',
                gap: '3',
                background: '#fff',
              })
            "
            @submit.prevent="sendMessage"
          >
            <FieldRoot>
              <FieldLabel :class="css({ fontSize: 'xs', fontWeight: 'bold', textTransform: 'uppercase', letterSpacing: '0.06em', color: '#334155' })">
                Message manager
              </FieldLabel>
              <FieldTextarea
                v-model="draft"
                rows="3"
                placeholder="Message the manager with your next request..."
                :class="
                  css({
                    mt: '1.5',
                    width: 'full',
                    borderRadius: 'md',
                    border: '1px solid #cbd5e1',
                    bg: '#fff',
                    p: '3',
                    fontSize: 'sm',
                    lineHeight: '1.5',
                    outline: 'none',
                    resize: 'vertical',
                    minH: '18',
                    _focusVisible: {
                      borderColor: '#0f766e',
                      boxShadow: '0 0 0 3px rgba(15, 118, 110, 0.18)',
                    },
                  })
                "
              />
              <FieldHelperText
                :class="css({ display: 'block', mt: '1.5', fontSize: 'xs', color: runtimeError ? '#b91c1c' : '#64748b' })"
              >
                {{ runtimeError ?? 'Chat stays available while agents run in the background.' }}
              </FieldHelperText>
            </FieldRoot>

            <button
              type="submit"
              :disabled="!canSend"
              :class="
                css({
                  justifySelf: 'start',
                  border: 'none',
                  borderRadius: 'md',
                  background: canSend ? '#0f766e' : '#94a3b8',
                  color: '#f0fdfa',
                  px: '4',
                  py: '2',
                  fontSize: 'sm',
                  fontWeight: 'semibold',
                  cursor: canSend ? 'pointer' : 'not-allowed',
                  _hover: { background: canSend ? '#0d9488' : '#94a3b8' },
                })
              "
            >
              {{ sending ? 'Sending...' : 'Send to Manager' }}
            </button>
          </form>
        </article>

        <aside
          :class="
            cx(
              panelClass,
              css({
                p: { base: '4', lg: '5' },
                display: 'grid',
                gap: '4',
                position: { lg: 'sticky' },
                top: { lg: '8' },
                animationDelay: '90ms',
              }),
            )
          "
        >
          <div>
            <h2 :class="css({ margin: 0, fontSize: 'lg', color: '#0f172a' })">Agent Task Visibility</h2>
            <p :class="css({ margin: 0, mt: '1', fontSize: 'sm', color: '#475569' })">
              Live view of active work, off-sick agents, and recent completions.
            </p>
          </div>

          <TabsRoot v-model="taskView">
            <TabList :class="tabsListClass">
              <TabTrigger value="active" :class="tabTriggerClass">Active</TabTrigger>
              <TabTrigger value="blocked" :class="tabTriggerClass">Blocked</TabTrigger>
              <TabTrigger value="recent" :class="tabTriggerClass">Recent</TabTrigger>
              <TabIndicator :class="tabsIndicatorClass" />
            </TabList>

            <TabContent value="active" :class="css({ mt: '3', display: 'grid', gap: '3' })">
              <p v-if="activeTasks.length === 0" :class="css({ margin: 0, fontSize: 'sm', color: '#64748b' })">
                No active tasks right now.
              </p>

              <article
                v-for="task in activeTasks"
                :key="task.id"
                :class="
                  css({
                    border: '1px solid #e5e7eb',
                    borderRadius: 'lg',
                    p: '3',
                    display: 'grid',
                    gap: '2',
                    background: '#fff',
                  })
                "
              >
                <div :class="css({ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '2' })">
                  <p :class="css({ margin: 0, fontSize: 'xs', fontWeight: 'bold', color: '#334155' })">{{ task.agent }}</p>
                  <span :class="statusPill(task.state)">{{ task.state }}</span>
                </div>

                <p :class="css({ margin: 0, fontSize: 'sm', color: '#0f172a', lineHeight: 1.4 })">
                  {{ task.title }}
                </p>

                <div :class="css({ display: 'flex', justifyContent: 'space-between', alignItems: 'center' })">
                  <p :class="css({ margin: 0, fontSize: 'xs', color: '#64748b' })">{{ task.id }}</p>
                  <p :class="css({ margin: 0, fontSize: 'xs', color: '#475569', fontWeight: 'semibold' })">
                    Running for {{ task.runningFor }}
                  </p>
                </div>

                <p :class="css({ margin: 0, fontSize: 'xs', color: '#64748b' })">Started {{ task.startedAt }}</p>
              </article>
            </TabContent>

            <TabContent value="blocked" :class="css({ mt: '3', display: 'grid', gap: '3' })">
              <p v-if="blockedTasks.length === 0" :class="css({ margin: 0, fontSize: 'sm', color: '#64748b' })">
                No blocked agents.
              </p>

              <article
                v-for="task in blockedTasks"
                :key="task.id"
                :class="
                  css({
                    border: '1px solid #f5d0a3',
                    borderRadius: 'lg',
                    p: '3',
                    display: 'grid',
                    gap: '1.5',
                    background: '#fffbeb',
                  })
                "
              >
                <p :class="css({ margin: 0, fontSize: 'xs', fontWeight: 'bold', color: '#92400e' })">{{ task.agent }}</p>
                <p :class="css({ margin: 0, fontSize: 'sm', color: '#7c2d12' })">{{ task.issue }}</p>
                <p :class="css({ margin: 0, fontSize: 'xs', color: '#92400e' })">Blocked since {{ task.since }}</p>
              </article>
            </TabContent>

            <TabContent value="recent" :class="css({ mt: '3', display: 'grid', gap: '3' })">
              <p v-if="recentTasks.length === 0" :class="css({ margin: 0, fontSize: 'sm', color: '#64748b' })">
                No recent completed tasks yet.
              </p>

              <article
                v-for="task in recentTasks"
                :key="task.id"
                :class="
                  css({
                    border: '1px solid #d1fae5',
                    borderRadius: 'lg',
                    p: '3',
                    display: 'grid',
                    gap: '1',
                    background: '#ecfdf5',
                  })
                "
              >
                <p :class="css({ margin: 0, fontSize: 'sm', color: '#065f46' })">{{ task.title }}</p>
                <p :class="css({ margin: 0, fontSize: 'xs', color: '#047857' })">{{ task.by }} · {{ task.completedAt }}</p>
              </article>
            </TabContent>
          </TabsRoot>
        </aside>
      </section>
    </div>
  </main>
</template>
