const {
  createStepTrace,
  addTraceStep,
  finalizeStepTrace,
  writeStepTrace,
} = require('../replay/step-trace');
const { createModularTaskFile } = require('./modular-browser-task-factory');

async function runModularTask(task, context = {}) {
  const trace = createStepTrace(task);
  try {
    addTraceStep(trace, {
      step: 'load_definition',
      status: 'ok',
      detail: 'normalized task definition',
    });

    addTraceStep(trace, {
      step: 'load_site_adapter',
      status: 'ok',
      detail: 'phase-1 placeholder adapter loaded',
    });

    let effectiveTask = task;
    if (task.use_browser) {
      const generatedPath = createModularTaskFile(task);
      addTraceStep(trace, {
        step: 'generate_modular_task_file',
        status: 'ok',
        detail: generatedPath,
      });
      effectiveTask = {
        ...task,
        type: 'javascript',
        script_path: generatedPath,
      };
    }

    addTraceStep(trace, {
      step: 'handoff_to_legacy_runner',
      status: 'ok',
      detail: task.use_browser
        ? 'modular action chain delegates execution via generated JS task'
        : 'phase-1 modular mode delegates execution to existing runner',
    });

    let result;
    try {
      result = await context.runLegacy(effectiveTask);
    } catch (error) {
      if (!context.runLegacyOriginal) throw error;
      addTraceStep(trace, {
        step: 'modular_runner_fallback',
        status: 'warn',
        detail: `fallback to original script: ${error?.message || String(error)}`,
      });
      result = await context.runLegacyOriginal(task);
    }

    const status = result?.status === 'success' ? 'success' : 'failed';
    finalizeStepTrace(trace, status);
    const replayPath = writeStepTrace(trace, `task-${task.id}-modular`);
    const modularFailedStep = String(result?.errorText || '').match(/failed_step=([a-zA-Z0-9_-]+)/)?.[1] || '';

    const mergedErrorText = status === 'failed'
      ? [
        result?.errorText,
        modularFailedStep ? `failed_step=${modularFailedStep}` : null,
        replayPath ? `replay_trace=${replayPath}` : null,
      ].filter(Boolean).join('\n')
      : (result?.errorText || null);

    return {
      ...result,
      status,
      errorText: mergedErrorText,
    };
  } catch (error) {
    addTraceStep(trace, {
      step: 'modular_runner_exception',
      status: 'failed',
      detail: error?.message || String(error),
    });
    finalizeStepTrace(trace, 'failed');
    writeStepTrace(trace, `task-${task.id}-modular`);
    throw error;
  }
}

module.exports = {
  runModularTask,
};
