import log from '../logger.js';
import bus from '../bus.js';
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
          }
          break;

        case 'logic':
          if (node.action === 'delay') {
            await new Promise(r => setTimeout(r, data.ms || 1000));
          } else if (node.action === 'chance') {
            const prob = (data.probability ?? 50) / 100;
            outputPort = Math.random() < prob ? 'true' : 'false';
          } else if (node.action === 'filter') {
            // Field can be a dotted path or a full {{ expression }}
            const val    = node.data?.field?.includes('{{')
              ? resolve(node.data.field, exprCtx)
              : this.getNested(event, node.data?.field);
            const target = data.value;
            const op     = data.operator || '==';

            let pass = false;
            if (op === '==') pass = val === target;
            if (op === '!=') pass = val !== target;
            if (op === '>')  pass = Number(val) >  Number(target);
            if (op === '<')  pass = Number(val) <  Number(target);
            if (op === '>=') pass = Number(val) >= Number(target);
            if (op === '<=') pass = Number(val) <= Number(target);

            if (!pass) return;
            outputPort = 'true';
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
}

const engine = new FlowEngine();
export default engine;
