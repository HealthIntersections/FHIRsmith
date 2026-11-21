// A client error (an Error carrying a 4xx statusCode: code not found, cache-id unknown, code
// system not found...) is the answer to the request, which the request's own log line records.
// Logged as an error or warning it is noise, so it is logged only when debugging. Anything
// else - a 5xx, an Error with no statusCode - is logged, with its stack
const Logger = require('../../library/logger');

describe('Logger: client errors', () => {
  const logger = Logger.getInstance();
  let lines;
  let level;
  let enqueue;

  beforeEach(() => {
    lines = [];
    level = logger.level;
    enqueue = logger._enqueue;
    logger._enqueue = (line) => lines.push(line);
    logger.setLevel('info');
    lines.length = 0; // (setLevel logs the change)
  });

  afterEach(() => {
    logger._enqueue = enqueue;
    logger.setLevel(level);
  });

  const withStatus = (message, statusCode) => Object.assign(new Error(message), { statusCode });

  test('a 4xx error is not logged', () => {
    logger.error(withStatus('Unknown code', 404));
    logger.warn(withStatus('Code system not found', 422));
    expect(lines).toEqual([]);
  });

  test('a 4xx error logged through a module logger is not logged', () => {
    const child = logger.child({ module: 'tx' });
    child.error(withStatus("The cache 'x' was never issued by this server", 404));
    child.error(withStatus('Bad Accept-Language', 400));
    expect(lines).toEqual([]);
  });

  test('when debugging, a 4xx error is logged, with its stack', () => {
    logger.setLevel('debug');
    lines.length = 0;
    logger.child({ module: 'tx' }).error(withStatus('Unknown code', 404));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('{tx}: Unknown code');
    expect(lines[0]).toContain('logger-client-errors.test.js');
  });

  test('a server error, or an error with no status, is logged with its stack', () => {
    const child = logger.child({ module: 'tx' });
    child.error(withStatus('Code system provider produced an invalid response', 500));
    child.error(new Error('something broke'));
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain('{tx}: Code system provider produced an invalid response');
    expect(lines[0]).toContain('logger-client-errors.test.js');
    expect(lines[1]).toContain('{tx}: something broke');
  });

  test('a message is logged as before', () => {
    logger.error('a plain message');
    logger.child({ module: 'tx' }).warn('a warning');
    expect(lines).toHaveLength(2);
  });
});
