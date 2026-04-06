import { EventEmitter } from 'node:events';
import { pushToAgent, pushToAgents } from './sse.mjs';

const bus = new EventEmitter();
bus.setMaxListeners(100); // Support many subscribers

// Event types
const EVENT_TYPES = [
  'state_changed',
  'approval_requested',
  'approval_resolved',
  'agent_online',
  'knowledge_gap_detected',
  'audit_alert',
];

// Publish an event
export function publish(type, payload) {
  if (!EVENT_TYPES.includes(type)) {
    console.warn(`[EventBus] Unknown event type: ${type}`);
  }
  const event = {
    type,
    ...payload,
    timestamp: new Date().toISOString(),
  };
  bus.emit(type, event);
  bus.emit('*', event); // Wildcard for listeners that want all events
  return event;
}

// Subscribe to events (internal, for server-side handlers)
export function subscribe(type, handler) {
  bus.on(type, handler);
  return () => bus.off(type, handler); // Return unsubscribe function
}

// Subscribe to all events
export function subscribeAll(handler) {
  bus.on('*', handler);
  return () => bus.off('*', handler);
}

// Built-in handler: forward state_changed events to SSE subscribers
// Subscriber list is included in the event payload by db.mjs (avoids circular import)
subscribe('state_changed', (event) => {
  const { subscribers, changed_by } = event;
  if (!subscribers || !Array.isArray(subscribers) || subscribers.length === 0) return;

  const targets = subscribers.filter(s => s !== changed_by);
  if (targets.length > 0) {
    // Send a clean event without the subscribers list
    const { subscribers: _subs, ...cleanEvent } = event;
    pushToAgents(targets, cleanEvent);
  }
});

// Built-in handler: forward approval_requested to the approver via SSE
// Also forward to Chairman so WeChat bridge can push notification
subscribe('approval_requested', (event) => {
  const { approver } = event;
  const targets = new Set();
  if (approver) targets.add(approver);
  targets.add('Chairman'); // WeChat bridge needs this for WeChat push
  pushToAgents([...targets], event);
});

// Built-in handler: forward approval_resolved to the proposer via SSE
subscribe('approval_resolved', (event) => {
  const { proposed_by } = event;
  if (proposed_by) {
    pushToAgent(proposed_by, event);
  }
});

// Built-in handler: audit_alert goes to Audit agent
subscribe('audit_alert', (event) => {
  pushToAgent('Audit', event);
});

export default bus;
