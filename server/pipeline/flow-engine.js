import log from '../logger.js';
import bus from '../bus.js';
import state from '../state.js';
import { makeCtx, resolveDeep, resolve } from '../template.js';

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
    const activeFlows = this.#flows.filter(f => f.active && f.trigger === event.type);
    
    for (const flow of activeFlows) {
      log.debug(`Executing flow [${flow.name || flow.id}] for event ${event.type}`);
      this.executeFlow(flow, event, broadcastEffect).catch(err => {
        log.error(`Flow execution error [${flow.id}]:`, err.message);
      });
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

const engine = new FlowEngine();
export default engine;
