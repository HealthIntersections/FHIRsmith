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

async function render(template, metrics, view = 'overlay') {
  const html = await liquid.renderFile(template, { metricsJson:JSON.stringify(metrics),
    historyJson:JSON.stringify(metrics.series[0]?.history || []), startTime:now });
  const elements = new Map([...html.matchAll(/id="([^"]+)"/g)].map(m => [m[1], makeElement()]));
  for (const [id, element] of elements) if (id.endsWith('Chart')) element.parentElement = makeElement();
  const charts = [];
  const context = vm.createContext({
    document:{ getElementById:id => elements.get(id), createElement:makeElement, createTextNode:text => ({ text }) },
    location:{search:'?chartView=' + view},
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
  expect(html).toContain('Heap change since process start');
  for (const chart of charts) {
    expect(chart.data.datasets.map(d => d.label)).toEqual(['Master m0', 'Worker tx1', 'Worker tx2']);
    expect(chart.data.datasets[1].data.map(d => d.x)).toEqual([now + 3000, now + 12000]);
    expect(chart.data.datasets[1].data[1].y).toBeNull();
    expect(chart.data.datasets[2].data).toEqual([]);
    expect(chart.options.scales.x).toMatchObject({ type:'linear', min:now, max:now + 20000 });
    expect(chart.data.datasets.every(d => d.fill === false && d.spanGaps === false)).toBe(true);
    expect(new Set(chart.data.datasets.map(d => d.pointStyle)).size).toBe(3);
  }
  const legend = elements.get('serverMetricsLegend').children.flatMap(e => e.children).map(e => e.text || '').join(' ');
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

test('refusal annotations merge real overlapping intervals without adding process lines or shading recovery', async () => {
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
    expect(chart.data.datasets).toHaveLength(2);
    const fills = [];
    const ctx = { save() {}, restore() {}, beginPath() {}, rect() {}, clip() {}, fillRect(...args) { fills.push(args); } };
    chart.plugins[0].beforeDraw({ ctx, chartArea:{left:0,right:20,top:0,bottom:100}, scales:{x:{getPixelForValue:t => (t - now) / 1000}} });
    expect(fills).toEqual([[0, 0, 7, 100], [0, 0, 7, 2]]);
    expect(chart.options.plugins.tooltip.callbacks.afterLabel({raw:{refused:11}})).toContain('11 in this sample');
    expect(chart.options.plugins.tooltip.callbacks.afterLabel({raw:{refused:null}})).toBe('');
  }
});

test('process rows use shared time and value scales, with only the row process refusal intervals', async () => {
  const metrics = { cluster:true, sampledAt:now + 20000, series:[
    { label:'Master', status:'ready', history:[{ ...point(now + 5000, 20), intervalStart:now, refused:2 }] },
    { label:'Worker', status:'ready', history:[{ ...point(now + 10000, 2000), intervalStart:now + 5000, refused:0 }] }
  ] };
  const { charts } = await render('cluster-dash-metrics', metrics, 'process');
  expect(charts).toHaveLength(6);
  for (let i = 0; i < charts.length; i += 2) {
    expect(charts[i].data.datasets).toHaveLength(1);
    expect(charts[i + 1].data.datasets).toHaveLength(1);
    expect(charts[i].options.scales.y.min).toBe(charts[i + 1].options.scales.y.min);
    expect(charts[i].options.scales.y.max).toBe(charts[i + 1].options.scales.y.max);
    expect(charts[i].options.scales.x.min).toBe(charts[i + 1].options.scales.x.min);
    const fills = [];
    const ctx = { save() {}, restore() {}, beginPath() {}, rect() {}, clip() {}, fillRect(...args) { fills.push(args); } };
    charts[i + 1].plugins[0].beforeDraw({ ctx, chartArea:{left:0,right:20,top:0,bottom:100}, scales:{x:{getPixelForValue:t => t}} });
    expect(fills).toEqual([]); // This worker did not refuse requests.
  }
});

test('selecting a process highlights it across overlay charts without hiding data', async () => {
  const { charts, elements } = await render('cluster-dash-metrics', { cluster:true, sampledAt:now, series:[
    { label:'Master', status:'ready', history:[point(now, 1)] },
    { label:'Worker', status:'ready', history:[point(now, 100)] }
  ] });
  const legend = elements.get('serverMetricsLegend');
  legend.children[2].listeners.click();
  for (const chart of charts) {
    expect(chart.data.datasets[0].borderColor).toBe('#174a7e28');
    expect(chart.data.datasets[0].pointRadius).toBe(0);
    expect(chart.data.datasets[1].borderWidth).toBe(2.4);
    expect(chart.data.datasets.map(d => d.data[0].y)).not.toContain(null);
  }
  legend.children[0].listeners.click();
  expect(charts[0].data.datasets[0].borderColor).toBe('#174a7e');
});

test('an empty cluster snapshot still renders without an invented process', async () => {
  const { charts } = await render('cluster-dash-metrics', { cluster:true, sampledAt:now, series:[] });
  expect(charts).toHaveLength(3);
  expect(charts.every(c => c.data.datasets.length === 0)).toBe(true);
});

test.each(['home-metrics', 'dash-metrics'])('with no role, %s is main\'s template, drawn from the local history', async (name) => {
  const html = await liquid.renderFile(name, { historyJson:JSON.stringify([point(now, 1)]), startTime:now });
  expect(html).toContain('const historyData = [');
  expect(html).not.toContain('serverMetricsLegend');
});
