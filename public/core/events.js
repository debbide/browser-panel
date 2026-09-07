(function exposeEventStream(global) {
  function createEventStream({
    refreshStatus,
    loadWarpStatus,
    isRedirecting = () => false,
    sseUrl = '/api/events',
    refreshDebounceMs = 200,
    fallbackPollMs = 15000,
  }) {
    let eventSource = null;
    let refreshTimer = null;
    let fallbackTimer = null;
    let started = false;

    function scheduleRefresh() {
      if (refreshTimer) return;
      refreshTimer = setTimeout(() => {
        refreshTimer = null;
        refreshStatus();
      }, refreshDebounceMs);
    }

    function startFallbackPolling() {
      if (fallbackTimer) return;
      fallbackTimer = setInterval(() => {
        if (document.hidden || isRedirecting()) return;
        refreshStatus();
      }, fallbackPollMs);
    }

    function stopFallbackPolling() {
      if (!fallbackTimer) return;
      clearInterval(fallbackTimer);
      fallbackTimer = null;
    }

    function close() {
      if (eventSource) {
        eventSource.close();
        eventSource = null;
      }
      stopFallbackPolling();
      if (refreshTimer) {
        clearTimeout(refreshTimer);
        refreshTimer = null;
      }
    }

    function start() {
      if (started) return;
      started = true;

      document.addEventListener('visibilitychange', () => {
        if (!document.hidden) scheduleRefresh();
      });
      global.addEventListener('beforeunload', close);

      if (typeof EventSource === 'undefined') {
        startFallbackPolling();
        return;
      }

      eventSource = new EventSource(sseUrl);
      eventSource.onopen = () => {
        stopFallbackPolling();
        scheduleRefresh();
      };

      const onStateEvent = () => scheduleRefresh();
      eventSource.addEventListener('state', onStateEvent);
      eventSource.addEventListener('task', onStateEvent);
      eventSource.addEventListener('browser', onStateEvent);
      eventSource.addEventListener('warp', () => {
        if (!document.getElementById('warp-tab')?.hidden) loadWarpStatus();
      });

      eventSource.onerror = () => {
        // EventSource 自带重连，不用手动重建，这里只负责断开期间兜底轮询。
        if (eventSource && eventSource.readyState === EventSource.CLOSED) {
          eventSource.close();
          eventSource = null;
        }
        startFallbackPolling();
      };
    }

    return { start, close, scheduleRefresh };
  }

  global.createEventStream = createEventStream;
})(window);
