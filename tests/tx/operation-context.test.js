const { TimeTracker } = require('../../tx/operation-context');

describe('TimeTracker', () => {
  let timeTracker;

  beforeEach(() => {
    timeTracker = new TimeTracker();
  });

  test('should initialize with start time and empty steps', () => {
    expect(timeTracker.steps).toEqual([]);
    expect(timeTracker.startTime).toBeDefined();
    expect(typeof timeTracker.startTime).toBe('number');
  });

  test('should record steps with elapsed time', (done) => {
    timeTracker.step('first step');

    setTimeout(() => {
      timeTracker.step('second step');

      expect(timeTracker.steps).toHaveLength(2);
      expect(timeTracker.steps[0]).toMatch(/^\d+ms first step$/);
      expect(timeTracker.steps[1]).toMatch(/^\d+ms second step$/);

      // Second step should have higher elapsed time
      const firstElapsed = parseInt(timeTracker.steps[0].match(/(\d+)ms/)[1]);
      const secondElapsed = parseInt(timeTracker.steps[1].match(/(\d+)ms/)[1]);
      expect(secondElapsed).toBeGreaterThanOrEqual(firstElapsed);

      done();
    }, 10);
  });

  test('should return formatted log', () => {
    timeTracker.step('step 1');
    timeTracker.step('step 2');

    const log = timeTracker.log();
    expect(log).toContain('step 1');
    expect(log).toContain('step 2');
    expect(log).toContain('\n');
  });

  test('should create linked copy', () => {
    timeTracker.step('original step');
    const linked = timeTracker.link();

    expect(linked).toBeInstanceOf(TimeTracker);
    expect(linked.startTime).toBe(timeTracker.startTime);
    expect(linked.steps).toEqual(timeTracker.steps);
    expect(linked.steps).not.toBe(timeTracker.steps); // Should be copy, not reference
  });
});
