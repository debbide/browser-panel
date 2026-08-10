class WarpPolicy {
  constructor(manager, options = {}) {
    this.manager = manager;
    this.setInterval = options.setInterval || setInterval;
    this.clearInterval = options.clearInterval || clearInterval;
    this.timer = null;
    this.running = false;
  }

  start() {
    this.stop();
    const state = this.manager.state();
    if (!state || !state.desired_enabled || this.manager.shuttingDown) return;
    const policy = this.manager.getPolicy();
    const intervalMs = policy.healthIntervalMinutes * 60 * 1000;
    this.timer = this.setInterval(() => void this.tick(), intervalMs);
    this.timer.unref?.();
  }

  async tick() {
    if (this.running || this.manager.shuttingDown) return;
    this.running = true;
    try {
      await this.manager.runPolicyCheck();
    } catch (error) {
      this.manager.recordPolicyError(error);
    } finally {
      this.running = false;
    }
  }

  stop() {
    if (this.timer) this.clearInterval(this.timer);
    this.timer = null;
  }

  status() {
    return { active: Boolean(this.timer), checking: this.running };
  }
}

module.exports = { WarpPolicy };
