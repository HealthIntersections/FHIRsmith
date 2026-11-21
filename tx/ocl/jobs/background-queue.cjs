const Logger = require('../../../library/logger');
const oclLog = Logger.getInstance().child({ module: 'ocl' });

class OCLBackgroundJobQueue {
  static MAX_CONCURRENT = 2;
  static HEARTBEAT_INTERVAL_MS = 30000;
  static UNKNOWN_JOB_SIZE = Number.MAX_SAFE_INTEGER;
  static pendingJobs = [];
  static activeCount = 0;
  static queuedOrRunningKeys = new Set();
  static activeJobs = new Map();
  static heartbeatTimer = null;
  static enqueueSequence = 0;

  static enqueue(jobKey, jobType, runJob, options = {}) {
    if (!jobKey || typeof runJob !== 'function') {
      return false;
    }

    if (this.queuedOrRunningKeys.has(jobKey)) {
      return false;
    }

    this.queuedOrRunningKeys.add(jobKey);
    const resolveAndEnqueue = async () => {
      const resolvedSize = await this.#resolveJobSize(options);
      const normalizedSize = this.#normalizeJobSize(resolvedSize);
      const job = {
        jobKey,
        jobType: jobType || 'background-job',
        jobId: options?.jobId || jobKey,
        jobSize: normalizedSize,
        getProgress: typeof options?.getProgress === 'function' ? options.getProgress : null,
        runJob,
        enqueueOrder: this.enqueueSequence++,
        userRequested: !!options.userRequested
      };
      this.#insertPendingJobOrdered(job);
      this.ensureHeartbeatRunning();
      this.processNext();
    };

    Promise.resolve()
      .then(resolveAndEnqueue)
      .catch((error) => {
        this.queuedOrRunningKeys.delete(jobKey);
        const message = error && error.message ? error.message : String(error);
        oclLog.error(`Failed to enqueue background job: ${jobType || 'background-job'} ${jobKey}: ${message}`);
      });

    return true;
  }

  static async #resolveJobSize(options = {}) {
    if (typeof options?.resolveJobSize === 'function') {
      try {
        return await options.resolveJobSize();
      } catch (_error) {
        return this.UNKNOWN_JOB_SIZE;
      }
    }

    if (options && Object.prototype.hasOwnProperty.call(options, 'jobSize')) {
      return options.jobSize;
    }

    return this.UNKNOWN_JOB_SIZE;
  }

  static #normalizeJobSize(jobSize) {
    const parsed = Number.parseInt(jobSize, 10);
    if (!Number.isFinite(parsed) || parsed < 0) {
      return this.UNKNOWN_JOB_SIZE;
    }
    return parsed;
  }

  static #insertPendingJobOrdered(job) {
    // Prioridade máxima para userRequested
    if (job.userRequested) {
      this.pendingJobs.unshift(job);
      return;
    }
    let index = this.pendingJobs.findIndex(existing => {
      if (existing.jobSize === job.jobSize) {
        return existing.enqueueOrder > job.enqueueOrder;
      }
      return existing.jobSize > job.jobSize;
    });
    if (index < 0) {
      index = this.pendingJobs.length;
    }
    this.pendingJobs.splice(index, 0, job);
  }

  static isQueuedOrRunning(jobKey) {
    return this.queuedOrRunningKeys.has(jobKey);
  }

  static ensureHeartbeatRunning() {
    if (this.heartbeatTimer) {
      return;
    }

    this.heartbeatTimer = setInterval(() => {
      this.logHeartbeat();
    }, this.HEARTBEAT_INTERVAL_MS);

    if (typeof this.heartbeatTimer.unref === 'function') {
      this.heartbeatTimer.unref();
    }
  }

  static logHeartbeat() {
    const activeJobs = Array.from(this.activeJobs.values());
    const lines = [
      '[OCL] OCL background status:',
      ` active jobs: ${activeJobs.length}`,
      ` queued jobs: ${this.pendingJobs.length}`
    ];

    activeJobs.forEach((job, index) => {
      lines.push('');
      lines.push(` job ${index + 1}:`);
      lines.push(`   type: ${job.jobType || 'background-job'}`);
      lines.push(`   id: ${job.jobId || job.jobKey}`);
      lines.push(`   size: ${job.jobSize}`);
      lines.push(`   progress: ${this.formatProgress(job.getProgress)}`);
    });

    oclLog.info(lines.join('\n'));
  }

  static formatProgress(getProgress) {
    if (typeof getProgress !== 'function') {
      return 'unknown';
    }

    try {
      const progress = getProgress();
      if (typeof progress === 'number' && Number.isFinite(progress)) {
        const bounded = Math.max(0, Math.min(100, progress));
        return `${Math.round(bounded)}%`;
      }

      if (progress && typeof progress === 'object') {
        if (typeof progress.percentage === 'number' && Number.isFinite(progress.percentage)) {
          const bounded = Math.max(0, Math.min(100, progress.percentage));
          return `${Math.round(bounded)}%`;
        }

        if (
          typeof progress.processed === 'number' &&
          Number.isFinite(progress.processed) &&
          typeof progress.total === 'number' &&
          Number.isFinite(progress.total) &&
          progress.total > 0
        ) {
          const ratio = progress.processed / progress.total;
          const bounded = Math.max(0, Math.min(100, ratio * 100));
          return `${Math.round(bounded)}%`;
        }
      }
    } catch (_error) {
      return 'unknown';
    }

    return 'unknown';
  }

  static processNext() {
    while (this.activeCount < this.MAX_CONCURRENT && this.pendingJobs.length > 0) {
      const job = this.pendingJobs.shift();
      this.activeCount += 1;
      this.activeJobs.set(job.jobKey, {
        jobKey: job.jobKey,
        jobType: job.jobType,
        jobId: job.jobId || job.jobKey,
        jobSize: job.jobSize,
        getProgress: job.getProgress || null,
        startedAt: Date.now()
      });
      Promise.resolve()
        .then(() => job.runJob())
        .catch((error) => {
          const message = error && error.message ? error.message : String(error);
          oclLog.error(`Background job failed: ${job.jobType} ${job.jobKey}: ${message}`);
        })
        .finally(() => {
          this.activeCount -= 1;
          this.queuedOrRunningKeys.delete(job.jobKey);
          this.activeJobs.delete(job.jobKey);
          this.processNext();
        });
    }
  }
}

module.exports = {
  OCLBackgroundJobQueue
};
