import log from '../logger.js';
import bus from '../bus.js';

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
    const nodes = flow.nodes || {};
    const edges = flow.edges || [];

    // Find trigger node(s)
    const startNodes = Object.values(nodes).filter(n => n.type === 'trigger');
    
    for (const startNode of startNodes) {
      await this.runNode(startNode, nodes, edges, { event, broadcastEffect });
    }
  }

  async runNode(node, allNodes, allEdges, ctx) {
    const { event, broadcastEffect } = ctx;
    let outputPort = 'next'; // Default output port

    log.debug(`  Node: ${node.id} (${node.label || node.action || node.type})`);

    try {
      // ─── Node Logic ───
      switch (node.type) {
        case 'trigger':
          // Just a pass-through start point
          break;

        case 'action':
          if (node.action === 'spawnEffect') {
            broadcastEffect(node.data?.effect, node.data?.payload || {});
          } else if (node.action === 'playSound') {
            broadcastEffect('alert-banner', { sound: node.data?.file, vol: node.data?.volume }); 
          } else if (node.action === 'startTimer') {
            broadcastEffect('start-timer', { seconds: node.data?.seconds, label: node.data?.label });
          } else if (node.action === 'obsScene') {
            bus.publish({ source: 'studio', type: 'obs.set-scene', scene: node.data?.scene });
          }
          break;

        case 'logic':
          if (node.action === 'delay') {
            await new Promise(r => setTimeout(r, node.data?.ms || 1000));
          } else if (node.action === 'chance') {
            const prob = (node.data?.probability ?? 50) / 100;
            outputPort = Math.random() < prob ? 'true' : 'false';
          } else if (node.action === 'filter') {
            const val = this.getNested(event, node.data?.field);
            const target = node.data?.value;
            const op = node.data?.operator || '==';
            
            let pass = false;
            if (op === '==') pass = val == target;
            if (op === '>')  pass = val >  target;
            if (op === '<')  pass = val <  target;
            if (op === '!=') pass = val != target;

            if (!pass) return; // Halt this branch
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
      if (nextNode) return this.runNode(nextNode, allNodes, allEdges, ctx);
    }));
  }

  getNested(obj, path) {
    return path?.split('.').reduce((o, k) => o?.[k], obj);
  }
}

const engine = new FlowEngine();
export default engine;
