const path = require('path');
const vm = require('vm');
const { Liquid } = require('liquidjs');

const liquid = new Liquid({ root:path.join(__dirname, '../../tx/html'), extname:'.liquid' });
const now = 1800000000000;
const point = (time, rpm) => ({ time, rpm, mem:1048576, tat:5, block:2, blockMax:50, clientConcepts:6 });
const makeElement = () => ({ children:[], style:{}, appendChild(child) { this.children.push(child); } });

async function render(template, metrics) {
  const html = await liquid.renderFile(template, { metricsJson:JSON.stringify(metrics),
    historyJson:JSON.stringify(metrics.series[0].history), startTime:now });
  const elements = new Map([...html.matchAll(/id="([^"]+)"/g)].map(m => [m[1], makeElement()]));
  const charts = [];
  const context = vm.createContext({
    document:{ getElementById:id => elements.get(id), createElement:makeElement, createTextNode:text => ({ text }) },
    Chart:function(canvas, options) { charts.push({ canvas, ...options }); }
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
