import log from '../logger.js';
import bus from '../bus.js';
import state from '../state.js';
import { makeCtx, resolveDeep, resolve } from '../template.js';
import { setRollId } from '../index.js';
import { parseTraySpec, expandPercentile } from '../../shared/dice.js';

/**
 * Fokker Studio Engine
 * Interprets and executes node-based logic graphs.
 */

export class FlowEngine {
  #flows = [];

  constructor(flows = []) {
    this.#flows = flows;
  }

  setFlows(flows) {
    this.#flows = flows;
  }

  /**
   * Main entry point for events entering the flow system.
   */
  async processEvent(event, broadcastEffect) {
    const activeFlows = this.#flows.filter(f => {
      if (!f.active || f.trigger !== event.type) return false;
      // Redeem flows can scope themselves to a single reward title via the
      // Studio "Specific Reward" dropdown. Empty/missing = match every redeem
      // (the existing behavior, kept for back-compat with pre-v0.3.30 flows).
      // Compare case-insensitively because Twitch reward titles are
      // human-typed and casing drift between dashboard config and Twitch is
      // a footgun we'd rather absorb than expose.
      if (event.type === 'redeem' && f.rewardTitle) {
        const flowTitle  = String(f.rewardTitle).toLowerCase();
        const eventTitle = String(event.payload?.rewardTitle || '').toLowerCase();
        if (flowTitle !== eventTitle) return false;
      }
      return true;
    });

    for (const flow of activeFlows) {
      log.debug(`Executing flow [${flow.name || flow.id}] for event ${event.type}`);
      this.executeFlow(flow, event, broadcastEffect).catch(err => {
        log.error(`Flow execution error [${flow.id}]:`, err.message);
      });
    }
  }

  /**
   * "Test This Trigger" entry point from Studio's right-click menu. Walks
   * only the chain rooted at the given flow's trigger — does NOT fan out to
   * every flow listening to the same event type, so the user gets isolated
   * preview of the flow they're actually editing. The flow's `active` flag
   * is bypassed too, so disabled flows can be poked while being built.
   */
  async testFlow(flowId, event, broadcastEffect) {
    const flow = this.#flows.find(f => f.id === flowId);
    if (!flow) {
      log.warn(`testFlow: no flow with id ${flowId}`);
      return;
    }
    log.info(`Test-running flow [${flow.name || flow.id}] with synthetic ${event.type} event`);
    try {
      await this.executeFlow(flow, event, broadcastEffect);
    } catch (err) {
      log.error(`Test flow execution error [${flow.id}]:`, err.message);
    }
  }

  async executeFlow(flow, event, broadcastEffect) {
    const nodes   = flow.nodes || {};
    const edges   = flow.edges || [];
    const exprCtx = makeCtx(event);  // build once per flow execution

    const startNodes = Object.values(nodes).filter(n => n.type === 'trigger');
    for (const startNode of startNodes) {
      await this.runNode(startNode, nodes, edges, { event, broadcastEffect, exprCtx }, 0);
    }
  }

  async runNode(node, allNodes, allEdges, ctx, depth = 0) {
    const { event, broadcastEffect, exprCtx } = ctx;
    let outputPort = 'next';

    if (depth > 20) {
      log.warn(`Flow recursion limit reached for flow [${node.id}] — check for infinite loops.`);
      return;
    }

    log.debug(`  Node: ${node.id} (${node.label || node.action || node.type})`);
    
    // Broadcast node execution to dashboards for visual highlighting
    bus.publish({ source: 'flow-engine', type: 'flow.node-fired', nodeId: node.id });

    // Resolve all node data fields through the expression engine
    const data = resolveDeep(node.data ?? {}, exprCtx);

    try {
      switch (node.type) {
        case 'trigger':
          break;

        case 'action':
          if (node.action === 'spawnEffect') {
            broadcastEffect(data.effect, data.payload || {}, event.isTest);
          } else if (node.action === 'playSound') {
            broadcastEffect('alert-banner', { sound: data.file, vol: data.volume }, event.isTest);
          } else if (node.action === 'startTimer') {
            broadcastEffect('start-timer', { seconds: data.seconds, label: data.label }, event.isTest);
          } else if (node.action === 'obsScene') {
            bus.publish({ source: 'studio', type: 'obs.set-scene', scene: data.scene, isTest: event.isTest });
          } else if (node.action === 'showBanner') {
            broadcastEffect('alert-banner', { tier: data.tier || 'B', icon: data.icon || '📢', text: data.text, subText: data.subText }, event.isTest);
          } else if (node.action === 'showImage') {
            broadcastEffect('image-show', {
              src: data.file,
              durationMs: Number(data.durationMs) || 5000,
            }, event.isTest);
          } else if (node.action === 'adjustEnergy') {
            const current = state.get('crowd.energy') ?? 0;
            const amount  = Number(data.amount);
            const mode    = data.mode || 'set';
            
            let next = amount;
            if (mode === 'add')      next = current + amount;
            if (mode === 'subtract') next = current - amount;

            next = Math.max(0, Math.min(100, next));
            state.set('crowd.energy', next);
            bus.publish({ source: 'studio', type: 'state', path: 'crowd.energy', value: next });
            if (next >= 100) broadcastEffect('crowd-explosion', {}, event.isTest);
          } else if (node.action === 'updateStat') {
            if (data.path) state.increment(data.path, Number(data.by ?? 1));
          } else if (node.action === 'rollDice') {
            const sides = Number(data.sides || 20);
            const roll  = Math.floor(Math.random() * sides) + 1;
            ctx.exprCtx.roll = roll; // Inject into context for future nodes
            broadcastEffect('dice-roll', { result: roll, sides, user: event.payload?.user }, event.isTest);
          } else if (node.action === 'rollDiceTray') {
            // Kick off a dice-tray widget roll. The overlay widget produces the
            // authentic physics-based result and publishes dice-tray.rolled
            // separately — use that as a flow trigger to branch on the result.
            const groups = parseTraySpec(data.spec) ?? [{ sides: 6, count: 2 }];
            const rid = Math.random().toString(36).slice(2);
            setRollId(rid);

            const dice = expandPercentile(groups);

            const payload = { dice, user: event.payload?.user, rollId: rid };
            if (data.theme) payload.theme = data.theme;
            if (data.tag)   payload.tag   = data.tag;
            bus.publish({
              source: 'flow-engine',
              type: 'dice-tray-roll',
              payload,
              isTest: event.isTest,
            });
          } else if (node.action === 'fireEvent') {
            let payload = data.payload;
            if (typeof payload === 'string') {
              try { payload = JSON.parse(payload); } catch { /* fail soft */ }
            }
            // Re-inject a new event into the bus
            bus.publish({ source: 'flow-engine', type: data.eventType, payload, isTest: event.isTest });
          } else if (node.action === 'kaprekar') {
            // Pick a valid 4-digit number (at least two distinct digits)
            let startNum;
            while (true) {
              startNum = Math.floor(Math.random() * 10000);
              const digits = startNum.toString().padStart(4, '0').split('');
              if (new Set(digits).size >= 2 && startNum !== 6174) break;
            }

            const steps = [];
            let current = startNum;
            let iterations = 0;

            while (current !== 6174 && iterations < 10) {
              const digits = current.toString().padStart(4, '0').split('');
              const desc = parseInt([...digits].sort((a,b) => b-a).join(''));
              const asc  = parseInt([...digits].sort((a,b) => a-b).join(''));
              const diff = desc - asc;
              steps.push(`${desc.toString().padStart(4, '0')} - ${asc.toString().padStart(4, '0')} = ${diff.toString().padStart(4, '0')}`);
              current = diff;
              iterations++;
            }
            
            ctx.exprCtx.kaprekar = { start: startNum.toString().padStart(4, '0'), iterations, steps };
            broadcastEffect('kaprekar-routine', { start: startNum, steps, iterations, user: event.payload?.user }, event.isTest);
          }
          break;

        case 'logic':
          if (node.action === 'delay') {
            await new Promise(r => setTimeout(r, data.ms || 1000));
          } else if (node.action === 'chance') {
            const prob = (data.probability ?? 50) / 100;
            outputPort = Math.random() < prob ? 'true' : 'false';
          } else if (node.action === 'filter') {
            const val    = this.resolveField(data.field, event);
            const target = data.value;
            const op     = data.operator || '==';

            let pass = false;
            if (op === '==') pass = val == target;
            if (op === '!=') pass = val != target;
            if (op === '>')  pass = Number(val) >  Number(target);
            if (op === '<')  pass = Number(val) <  Number(target);
            if (op === '>=') pass = Number(val) >= Number(target);
            if (op === '<=') pass = Number(val) <= Number(target);

            if (!pass) return;
            outputPort = 'true';
          } else if (node.action === 'match') {
            const val = this.resolveField(data.field, event);
            if (val == data.match1) outputPort = 'case1';
            else if (val == data.match2) outputPort = 'case2';
            else if (val == data.match3) outputPort = 'case3';
            else outputPort = 'default';
          }
          break;
      }
    } catch (err) {
      log.error(`    Node ${node.id} failed:`, err.message);
      return;
    }

    // ─── Traversal ───
    const nextEdges = allEdges.filter(e => e.src === node.id && e.outPort === outputPort);
    
    // Execute all connected children in parallel
    await Promise.all(nextEdges.map(edge => {
      const nextNode = allNodes[edge.dst];
      if (nextNode) return this.runNode(nextNode, allNodes, allEdges, ctx, depth + 1);
    }));
  }

  getNested(obj, path) {
    return path?.split('.').reduce((o, k) => o?.[k], obj);
  }

  // Filter/Match field spec: literal value if already resolved by templates,
  // otherwise a dotted path into the event (e.g. "payload.viewers").
  resolveField(spec, event) {
    if (spec == null) return undefined;
    if (typeof spec !== 'string') return spec;         // already resolved by resolveDeep (e.g. {{ expr }})
    if (/^-?\d+(\.\d+)?$/.test(spec)) return Number(spec);
    if (spec.includes('.') || spec === 'payload' || spec === 'event') {
      return this.getNested({ payload: event.payload, event }, spec);
    }
    return spec; // plain literal string
  }
}

// Default synthetic payloads for "Test This Trigger" — kept in one place so
// they're easy to edit later. Fokker explicitly asked for centralisation
// (issue #6): future per-flow overrides should land here, not get scattered
// across the studio UI and server handlers.
export const TEST_PAYLOADS = {
  'follow':              { user: 'TestUser', userId: '0' },
  'sub':                 { user: 'TestUser', tier: '1000', message: 'test sub' },
  'sub.gifted':          { user: 'TestUser', count: 1, tier: '1000', recipient: 'GiftedUser' },
  'cheer':               { user: 'TestUser', bits: 100, message: 'cheer100 test' },
  'raid':                { user: 'TestUser', viewers: 10 },
  'redeem':              { user: 'TestUser', rewardTitle: 'Test Redeem', rewardId: 'test-id', input: '' },
  'chat':                { user: 'TestUser', message: 'hello world', color: '#FFFFFF', badges: [], userIsMod: false, userIsVip: false, userIsSub: false, userMonthsSubbed: 0 },
  'hype-train.start':    { level: 1, total: 100 },
  'hype-train.progress': { level: 1, total: 100, progress: 50, goal: 100 },
  'hype-train.end':      { level: 2, total: 250 },
  'dice-tray-roll':      { user: 'TestUser', dice: [{ sides: 20, result: 12 }], rollId: 'test', sum: 12, total: { 20: 12 } },
};

const engine = new FlowEngine();
export default engine;
