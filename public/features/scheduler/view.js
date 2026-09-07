(function exposeSchedulerView(global) {
  function render(renderSettings, settings) {
    return renderSettings(settings);
  }

  function collect(collectSettings) {
    return collectSettings();
  }

  function setStatus(updateStatus, text, color) {
    return updateStatus(text, color);
  }

  global.SchedulerView = { render, collect, setStatus };
})(window);
