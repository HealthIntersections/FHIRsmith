const path = require('path');
const vm = require('vm');
const { Liquid } = require('liquidjs');

const liquid = new Liquid({ root:path.join(__dirname, '../../tx/html'), extname:'.liquid' });
const now = 1800000000000;
const point = (time, rpm) => ({ time, rpm, mem:1048576, tat:5, block:2, blockMax:50, clientConcepts:6 });
const makeElement = () => ({ children:[], style:{}, attributes:{}, listeners:{}, classList:{ toggle() {} },
  appendChild(child) { child.parentElement = this; this.children.push(child); },
  replaceChildren(...children) { this.children = []; children.forEach(child => this.appendChild(child)); },
  setAttribute(name, value) { this.attributes[name] = value; },
  addEventListener(name, callback) { this.listeners[name] = callback; }
});

const legendText = elements => elements.get('serverMetricsLegend').children
  .flatMap(e => e.children || [e]).map(e => e.text || '').join(' ');
const hatchCalls = (chart, pixel) => {
  const calls = [];
  const ctx = new Proxy({}, { get:(_t, name) => (...args) => calls.push([name, ...args]) });
  chart.plugins[0].beforeDraw({ ctx, chartArea:{left:0,right:20,top:0,bottom:100}, scales:{x:{getPixelForValue:pixel}} });
  return calls;
};

async function render(template, metrics) {
  const html = await liquid.renderFile(template, { metricsJson:JSON.stringify(metrics),
    historyJson:JSON.stringify(metrics.series[0]?.history || []), startTime:now });
  const elements = new Map([...html.matchAll(/id="([^"]+)"/g)].map(m => [m[1], makeElement()]));
  for (const [id, element] of elements) if (id.endsWith('Chart')) element.parentElement = makeElement();
  const charts = [];
  const context = vm.createContext({
    document:{ getElementById:id => elements.get(id), createElement:makeElement, createTextNode:text => ({ text }) },
    Chart:function(canvas, options) {
      Object.assign(this, { canvas, ...options });
      this.update = () => {}; this.destroy = () => {};
      charts.push(this);
    }
  });
  for (const script of html.matchAll(/<script>([\s\S]*?)<\/script>/g)) vm.runInContext(script[1], context);
  return { html, charts, elements };
}

test.each([['cluster-dash-metrics', 3], ['cluster-home-metrics', 6]])('%s renders each process on the existing charts at its real sample times', async (name, count) => {
  const metrics = { cluster:true, sampledAt:now + 20000, series:[
    { label:'Master m0', status:'ready', history:[point(now, 1), point(now + 10000, 2)] },
    { label:'Worker tx1', status:'restarting', restarts:1, history:[point(now + 3000, 7), { time:now + 12000, rpm:null, mem:null }] },
    { label:'Worker tx2', status:'starting', history:[] }
  ] };
  const { html, charts, elements } = await render(name, metrics);
  expect(charts).toHaveLength(count);
  expect(html).toContain('Private memory</h6>');
  // no private memory in the samples (not Linux): the heap change, and the title says so
  expect(elements.get('memoryChartTitle').textContent).toBe('Heap change since start');
  for (const chart of charts) {
    const total = [elements.get('requestChart'), elements.get('clientCacheChart')].includes(chart.canvas) ? ['Total'] : [];
    expect(chart.data.datasets.map(d => d.label)).toEqual(['Master m0', 'Worker tx1', 'Worker tx2', ...total]);
    expect(chart.data.datasets[1].data.map(d => d.x)).toEqual([now + 3000, now + 12000]);
    expect(chart.data.datasets[1].data[1].y).toBeNull();
    expect(chart.data.datasets[2].data).toEqual([]);
    // at least a minute's axis, ending at the snapshot
    expect(chart.options.scales.x).toMatchObject({ type:'linear', min:now - 40000, max:now + 20000 });
    expect(chart.data.datasets.every(d => d.fill === false && d.spanGaps === false)).toBe(true);
    expect(new Set(chart.data.datasets.slice(0, 3).map(d => d.pointStyle)).size).toBe(3);
  }
  const legend = legendText(elements);
  expect(legend).toContain('Worker tx1 · restarting · 1 restart');
  expect(legend).toContain('Worker tx2 · starting');
});

test('one series alone is drawn as one labeled filled series', async () => {
  const { charts } = await render('cluster-dash-metrics', { cluster:false, sampledAt:now,
    series:[{ label:'Server', status:'ready', history:[point(now, 1)] }] });
  for (const chart of charts) {
    expect(chart.data.datasets).toHaveLength(1);
    expect(chart.data.datasets[0]).toMatchObject({ label:'Server', fill:true });
    expect(chart.options.scales.x.min).toBeLessThan(chart.options.scales.x.max);
  }
});

test('refusals are hatched over merged real intervals, with counts in the note and tooltip', async () => {
  const { charts, elements } = await render('cluster-home-metrics', { cluster:true, sampledAt:now + 20000, series:[
    { label:'Master', status:'ready', history:[
      { ...point(now + 5000, 100), intervalStart:now, refused:7 },
      { ...point(now + 20000, 50), intervalStart:now + 5000, refused:0 }
    ] },
    { label:'Worker', status:'ready', history:[
      { ...point(now + 7000, 80), intervalStart:now + 3000, refused:11 },
      { time:now + 10000, refused:null, intervalStart:null }
    ] }
  ] });
  expect(elements.get('serverMetricsShedding').textContent).toContain('18 memory-pressure 503 refusals');
  expect(elements.get('serverMetricsShedding').hidden).toBe(false);
  for (const chart of charts) {
    const calls = hatchCalls(chart, t => (t - now) / 1000);
    expect(calls.filter(c => c[0] === 'rect')).toEqual([['rect', 0, 0, 7, 100]]);
    expect(calls.filter(c => c[0] === 'stroke')).toHaveLength(1); // the hatching, not a red fill
    expect(calls.filter(c => c[0] === 'fillRect')).toEqual([['fillRect', 0, 0, 7, 2]]);
    expect(chart.options.plugins.tooltip.callbacks.afterLabel({raw:{refused:11}})).toContain('11 in this sample');
    expect(chart.options.plugins.tooltip.callbacks.afterLabel({raw:{refused:null}})).toBe('');
  }
});

test('requests per minute adds a Total, summing each sample interval across processes', async () => {
  const minute = 60000;
  const { charts, elements } = await render('cluster-dash-metrics', { cluster:true, sampledAt:now + 3 * minute, series:[
    { label:'Master', status:'ready', intervalMs:minute, history:[point(now, 1), point(now + minute, 2), point(now + 2 * minute, 3)] },
    { label:'Worker', status:'ready', intervalMs:minute, history:[point(now + 2000, 10), { time:now + minute + 2000, rpm:null },
      point(now + 2 * minute + 2000, 30)] }
  ] });
  const rpm = charts.find(c => c.canvas === elements.get('requestChart'));
  const total = rpm.data.datasets.find(d => d.label === 'Total');
  expect(total.data).toEqual([{ x:now, y:11 }, { x:now + minute, y:2 }, { x:now + 2 * minute, y:33 }]);
  expect(total.borderWidth).toBeGreaterThan(rpm.data.datasets[0].borderWidth);
  expect(charts.filter(c => c.data.datasets.some(d => d.label === 'Total'))).toEqual([rpm]);
  expect(legendText(elements)).toContain('Total');
});

test('the memory graph: private memory per process, the cgroup\'s Total and the refusal threshold, labelled', async () => {
  const GiB = 2 ** 30;
  const anon = (time, gib) => ({ ...point(time, 1), anon:gib * GiB });
  const { charts, elements } = await render('cluster-home-metrics', { cluster:true, sampledAt:now + 120000, sharedCache:false,
    total:{ group:true, rejectAt:10.2 * GiB, history:[{ time:now, anon:5 * GiB }, { time:now + 60000, anon:null }, { time:now + 120000, anon:6 * GiB }] },
    series:[
      { label:'Master m0', status:'ready', intervalMs:60000, history:[anon(now, 3), anon(now + 60000, 3.5)] },
      { label:'Worker tx1', status:'ready', intervalMs:60000, history:[anon(now + 1000, 2), anon(now + 61000, 2.5)] }
    ] });
  const memory = charts.find(c => c.canvas === elements.get('memoryChart'));
  expect(memory.data.datasets.map(d => d.label)).toEqual(['Master m0', 'Worker tx1', 'Total', 'Refusal threshold']);
  expect(memory.data.datasets[0].data.map(d => d.y)).toEqual([3072, 3584]);
  // the cgroup's own figure, with its gap; not the processes summed
  expect(memory.data.datasets[2].data).toEqual([{ x:now, y:5120 }, { x:now + 60000, y:null }, { x:now + 120000, y:6144 }]);
  const threshold = memory.data.datasets[3];
  expect(threshold.data.map(d => d.y)).toEqual([10.2 * 1024, 10.2 * 1024]);
  expect(threshold.borderDash.length).toBeGreaterThan(0);
  expect(threshold.borderColor).not.toBe(memory.data.datasets[2].borderColor);
  expect(memory.options.scales.y.title.text).toBe('MB private (anon)');
  expect(elements.get('memoryChartTitle').textContent).toBeUndefined();
  const legend = legendText(elements);
  expect(legend).toContain('Total: requests per minute, client concepts, memory (the cgroup\'s private)');
  expect(legend).toContain('Memory guard refuses above 10.2 GB (the cgroup)');
  // the threshold's value is written on its line
  const texts = [];
  const ctx = new Proxy({}, { get:(_t, name) => name === 'fillText' ? (...args) => texts.push(args[0]) : () => {}, set:() => true });
  memory.plugins[1].afterDatasetsDraw({ ctx, data:memory.data, chartArea:{ left:0, right:100, top:0, bottom:100 },
    scales:{ y:{ getPixelForValue:() => 50 } } });
  expect(texts).toEqual(['refuses above 10.2 GB']);
});

test('client concepts add a Total: summed, or with the shared cache taken once', async () => {
  const minute = 60000;
  const concepts = (time, n) => ({ ...point(time, 1), clientConcepts:n });
  const series = [
    { label:'Master', status:'ready', intervalMs:minute, history:[concepts(now, 100), concepts(now + minute, 300)] },
    { label:'Worker', status:'ready', intervalMs:minute, history:[concepts(now + 2000, 100), concepts(now + minute + 2000, 300)] }
  ];
  const totalOf = async (sharedCache) => {
    const { charts, elements } = await render('cluster-home-metrics', { cluster:true, sampledAt:now + minute, sharedCache, series });
    return charts.find(c => c.canvas === elements.get('clientCacheChart')).data.datasets.find(d => d.label === 'Total').data;
  };
  expect(await totalOf(false)).toEqual([{ x:now, y:200 }, { x:now + minute, y:600 }]);
  expect(await totalOf(true)).toEqual([{ x:now, y:100 }, { x:now + minute, y:300 }]);
});

test('past eight processes, no style repeats: the rest are only in the Total and the note', async () => {
  const series = Array.from({ length:11 }, (_v, i) => ({ label:'P' + i, status:'ready', intervalMs:600000, history:[point(now, 1)] }));
  const { charts, elements } = await render('cluster-dash-metrics', { cluster:true, sampledAt:now, series });
  for (const chart of charts) {
    const processes = chart.data.datasets.filter(d => d.label !== 'Total');
    expect(processes).toHaveLength(8);
    for (const key of ['pointStyle', 'borderColor']) expect(new Set(processes.map(d => d[key])).size).toBe(8);
    expect(new Set(processes.map(d => JSON.stringify(d.borderDash))).size).toBe(8);
  }
  const rpm = charts.find(c => c.canvas === elements.get('requestChart'));
  expect(rpm.data.datasets.find(d => d.label === 'Total').data).toEqual([{ x:now, y:11 }]);
  expect(legendText(elements)).toContain('3 more workers are not drawn individually');
});

test('an empty cluster snapshot still renders without an invented process', async () => {
  const { charts } = await render('cluster-dash-metrics', { cluster:true, sampledAt:now, series:[] });
  expect(charts).toHaveLength(3);
  expect(charts.every(c => c.data.datasets.length === 0)).toBe(true);
  // and says it is waiting for samples, rather than showing empty axes alone
  const texts = [];
  const ctx = new Proxy({}, { get:(_t, name) => name === 'fillText' ? (...args) => texts.push(args[0]) : () => {}, set:() => true });
  charts[0].plugins.find(p => p.id === 'waitingForSamples').afterDatasetsDraw({ ctx, data:charts[0].data,
    chartArea:{ left:0, right:100, top:0, bottom:100 } });
  expect(texts).toEqual(['Waiting for samples']);
});

test.each(['home-metrics', 'dash-metrics'])('with no role, %s is main\'s template, drawn from the local history', async (name) => {
  const html = await liquid.renderFile(name, { historyJson:JSON.stringify([point(now, 1)]), startTime:now });
  expect(html).toContain('const historyData = [');
  expect(html).not.toContain('serverMetricsLegend');
});
