import log from '../logger.js';
import bus, { awaitBusEvent } from '../bus.js';
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
  #scenes = [];

  constructor(flows = []) {
    this.#flows = flows;
  }

  setFlows(flows) {
    this.#flows = flows;
  }

  // Registered so the playScene action can look up the full scene JSON by id.
  // Kept optional on the engine surface (callers use setScenes?.(...)) so old
  // call-sites in tests don't break.
  setScenes(scenes) {
    this.#scenes = scenes || [];
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
      // Symmetric scene-end scoping: a flow with sceneId set fires only
      // for that scene's completion; empty = "any scene end" (same
      // back-compat pattern as redeem's rewardTitle).
      if (event.type === 'scene-end' && f.sceneId) {
        if (String(f.sceneId) !== String(event.payload?.sceneId || '')) return false;
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
          } else if (node.action === 'showTwitchCard') {
            // Server enriches with avatar + display name via Helix before
            // broadcasting (see broadcastEffect → enrichTwitchCard); flow
            // just hands off the username and subtitle. Empty user → no-op
            // (otherwise we'd ship "—" cards on template-resolution misses).
            const user = String(data.user || '').trim();
            if (user) {
              broadcastEffect('twitch-card-show', {
                user,
                subtitle:   data.subtitle ?? '',
                durationMs: Number(data.durationMs) || 5000,
              }, event.isTest);
            }
          } else if (node.action === 'playScene') {
            // Look up the scene by id and ship the whole JSON to overlays.
            // Sending the full scene (rather than just the id) means the
            // overlay's scene-player doesn't have to re-fetch /api/scenes,
            // and avoids a race where the scene was edited between the flow
            // firing and the overlay loading it.
            const scene = this.#scenes.find(s => s.id === data.sceneId);
            if (!scene) {
              log.warn(`playScene: no scene with id "${data.sceneId}" — flow [${node.id}] skipped`);
            } else {
              broadcastEffect('scene-play', { scene }, event.isTest);
            }
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
            // Phase 7: emit the result onto the bus so awaitResult nodes
            // (and scene branch clips) can listen for it. Mirrors the
            // dice-tray.rolled feedback path that v0.3.30 added — gives
            // the simpler rollDice action the same primitive without
            // pulling in the heavier physics tray.
            bus.publish({ source: 'flow-engine', type: 'dice-rolled', payload: { value: roll, sides, user: event.payload?.user }, isTest: event.isTest });
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
          } else if (node.action === 'awaitResult') {
            // Pause flow execution until a matching event arrives on the
            // bus. Default 30s timeout so a stalled wait can't hang a
            // flow forever; downstream nodes see ctx.result = the
            // awaited event (or null on timeout, so flows can branch
            // via filter/match nodes on the absence of a result).
            const eventType = String(data.eventType || 'dice-rolled');
            const timeoutMs = Number(data.timeoutMs ?? 30000);
            try {
              const result = await awaitBusEvent(eventType, null, timeoutMs);
              ctx.exprCtx.result = result.payload ?? result;
            } catch (err) {
              log.debug(`awaitResult [${node.id}] ${eventType}: ${err.message}`);
              ctx.exprCtx.result = null;
            }
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
      log.error(`    Node ${node.id} (${node.label || node.action || node.type}) failed:`, err.message);
      // Surface to Studio so the failing node can be highlighted in red and
      // the props pane can show the error. Routed through the bus so any
      // dashboard listener picks it up — currently studio.js handles the
      // highlight, but other consumers (Event Log, future error panel) can
      // tap the same signal.
      bus.publish({
        source:  'flow-engine',
        type:    'flow.node-error',
        flowId:  node._flowId || '',
        nodeId:  node.id,
        nodeLabel: node.label || node.action || node.type,
        error:   err.message || String(err),
        isTest:  !!event.isTest,
      });
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
  'hype-train.start':    { level: 1, total: 100, goal: 1000, expiresAt: '2026-01-01T00:00:00Z' },
  'hype-train.progress': { level: 1, total: 100, progress: 50, goal: 100, expiresAt: '2026-01-01T00:00:00Z' },
  'hype-train.end':      { level: 2, total: 250, cooldownEndsAt: '2026-01-01T00:00:00Z' },
  // Cluster E test payloads — shaped to match what real Twitch events deliver
  // post-normalize so Test This Trigger renders banner text accurately.
  'prediction.start':    { id: 'test', title: 'Will the next boss die?', outcomes: [{ id: 'a', title: 'Yes', color: 'BLUE',   channelPoints: 0, users: 0 }, { id: 'b', title: 'No',  color: 'PINK', channelPoints: 0, users: 0 }], locksAt: '2026-01-01T00:00:00Z' },
  'prediction.lock':     { id: 'test', title: 'Will the next boss die?', outcomes: [{ id: 'a', title: 'Yes', color: 'BLUE',   channelPoints: 4200, users: 12 }, { id: 'b', title: 'No', color: 'PINK', channelPoints: 1800, users: 7 }], lockedAt: '2026-01-01T00:00:00Z' },
  'prediction.end':      { id: 'test', title: 'Will the next boss die?', outcomes: [{ id: 'a', title: 'Yes', color: 'BLUE',   channelPoints: 4200, users: 12 }, { id: 'b', title: 'No', color: 'PINK', channelPoints: 1800, users: 7 }], winningOutcomeId: 'a', winningOutcome: 'Yes', status: 'resolved', endedAt: '2026-01-01T00:00:00Z' },
  'poll.start':          { id: 'test', title: 'Next game?', choices: [{ id: 'a', title: 'Elden Ring', votes: 0, channelPointsVotes: 0, bitsVotes: 0, totalVotes: 0 }, { id: 'b', title: 'Helldivers', votes: 0, channelPointsVotes: 0, bitsVotes: 0, totalVotes: 0 }], endsAt: '2026-01-01T00:00:00Z' },
  'poll.end':            { id: 'test', title: 'Next game?', choices: [{ id: 'a', title: 'Elden Ring', votes: 18, channelPointsVotes: 5, bitsVotes: 2, totalVotes: 25 }, { id: 'b', title: 'Helldivers', votes: 9, channelPointsVotes: 0, bitsVotes: 0, totalVotes: 9 }], winningChoice: 'Elden Ring', winningChoiceId: 'a', status: 'completed', endedAt: '2026-01-01T00:00:00Z' },
  'charity.start':       { id: 'test', campaignName: 'Test Charity', website: 'https://example.org', target: { value: 1000, currency: 'USD' }, current: { value: 0, currency: 'USD' }, startedAt: '2026-01-01T00:00:00Z' },
  'charity.progress':    { id: 'test', campaignName: 'Test Charity', current: { value: 250, currency: 'USD' }, target: { value: 1000, currency: 'USD' } },
  'charity.donate':      { id: 'test', user: 'GenerousViewer', userId: '0', amount: { value: 10, currency: 'USD' }, campaignName: 'Test Charity' },
  'charity.stop':        { id: 'test', campaignName: 'Test Charity', stoppedAt: '2026-01-01T00:00:00Z', finalAmount: { value: 1234, currency: 'USD' } },
  'dice-tray-roll':      { user: 'TestUser', dice: [{ sides: 20, result: 12 }], rollId: 'test', sum: 12, total: { 20: 12 } },
  'scene-end':           { sceneId: 'test-scene', sceneName: 'Test Scene' },
};

const engine = new FlowEngine();
export default engine;
