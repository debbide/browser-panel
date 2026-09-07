const express = require('express');

function createSystemRouteRegistrars({
  fs,
  path,
  db,
  events,
  logStream,
  cleanupStorage,
  getRunningTaskIds,
  normalizeEnvEntriesPayload,
  normalizeVisionSettingsPayload,
  readUtf8Chunk,
  getVersion,
  getSuccessHeuristicSettings,
  setSuccessHeuristicSettings,
  testVisionChannel,
  logsDir,
}) {
  function registerPublicRoutes(app) {
    app.get('/api/version', (req, res) => {
      res.json({ data: getVersion() });
    });

  }

  function registerEventRoutes(app) {
    app.get('/api/events', (req, res) => {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        // nginx 反代默认会缓冲响应，缓冲了 SSE 就没有"实时"可言。CF Tunnel 不需要
        // 这个头，但加着不碍事，用户换 nginx 方案时不用再想起来补。
        'X-Accel-Buffering': 'no',
      });
      // Nagle 算法会把小包攒一会儿再发，SSE 要的就是小包立刻出去
      if (res.socket && typeof res.socket.setNoDelay === 'function') {
        res.socket.setNoDelay(true);
      }
      if (typeof res.flushHeaders === 'function') res.flushHeaders();
      events.addClient(res);
    });

  }

  function registerSettingsRoutes(app) {
    app.get('/api/settings/success-heuristics', (req, res) => {
        res.json({ data: getSuccessHeuristicSettings() });
    });

    app.post('/api/settings/success-heuristics', (req, res) => {
      try {
          const body = req.body || {};
        const updated = setSuccessHeuristicSettings({
          enabled: body.enabled,
          successPatternsText: body.successPatternsText,
          failurePatternsText: body.failurePatternsText,
          graceSec: body.graceSec,
        });
        res.json({ data: updated });
      } catch (error) {
        res.status(400).json({ message: error.message || 'Failed to save success heuristics' });
      }
    });

    app.get('/api/settings/vision', (req, res) => {
      res.json({ data: db.getVisionSettingsPublic() });
    });

    app.post('/api/settings/vision', (req, res) => {
      try {
        const payload = normalizeVisionSettingsPayload(req.body || {});
        const updated = db.setVisionSettings(payload);
        res.json({ data: updated });
      } catch (error) {
        res.status(400).json({ message: error.message || 'Failed to save vision settings' });
      }
    });

    app.post('/api/settings/vision/model', (req, res) => {
      try {
        const body = req.body || {};
        const id = String(body.id || '').trim();
        const model = String(body.model || '').trim();
        if (!id) return res.status(400).json({ message: '缺少通道 id' });
        if (!model) return res.status(400).json({ message: '缺少 model' });
        const updated = db.setVisionChannelModel(id, model);
        res.json({ data: updated });
      } catch (error) {
        res.status(400).json({ message: error.message || 'Failed to switch vision model' });
      }
    });

    app.post('/api/settings/vision/test', async (req, res) => {
      try {
          const body = req.body || {};
        const saved = db.getVisionSettings();
        const channelsInternal = typeof db.getVisionChannelsInternal === 'function'
          ? db.getVisionChannelsInternal()
          : [];
    
        const norm = (s) => String(s || '').trim().replace(/\/+$/, '').toLowerCase();
        const id = String(body.id || '').trim();
        const baseUrl = String(body.baseUrl || '').trim();
        const model = String(body.model || '').trim();
        let apiKey = String(body.apiKey || '').trim();
    
        if (!apiKey && baseUrl) {
          // 与保存路径共用同一个解析器（显式 key → id → baseUrl+model），避免两边规则各自漂移。
          if (typeof db.resolveVisionChannelKey === 'function') {
            apiKey = db.resolveVisionChannelKey({ incomingKey: '', id, baseUrl, model }, channelsInternal);
          }
          // 解析器不含「只匹配 baseUrl」这一档：改了 model 但没带 id 时（老前端）仍要能测通。
          if (!apiKey) {
            const sameBase = channelsInternal.find(
              (ch) => norm(ch.baseUrl) === norm(baseUrl) && ch.apiKey
            );
            apiKey = String((sameBase || {}).apiKey || '').trim();
          }
        }
    
        // Only if still empty and caller omitted baseUrl entirely, allow primary (legacy).
        if (!apiKey && !baseUrl) {
          const primarySaved = channelsInternal[0] || {
            baseUrl: saved.baseUrl,
            apiKey: saved.apiKey,
            model: saved.model,
          };
          apiKey = String(primarySaved.apiKey || saved.apiKey || '').trim();
        }
    
        const effectiveBase = baseUrl
          || String((channelsInternal[0] || {}).baseUrl || saved.baseUrl || '').trim();
        const effectiveModel = model
          || String((channelsInternal.find((ch) => norm(ch.baseUrl) === norm(effectiveBase)) || {}).model
            || (channelsInternal[0] || {}).model
            || saved.model
            || '').trim();
    
        if (!effectiveBase) {
          return res.status(400).json({ message: '请填写 Base URL' });
        }
        if (!apiKey) {
          return res.status(400).json({
            message: '该通道没有可用的 API Key：请在输入框粘贴 Key，或先保存该通道后再测（不会用主通道的 Key 顶替）',
          });
        }
    
        const data = await testVisionChannel(
          { baseUrl: effectiveBase, apiKey, model: effectiveModel },
          {
            fetchModels: body.fetchModels !== false,
            testImage: body.testImage !== false,
            model: effectiveModel,
          }
        );
        // Help debug without leaking full secret
        data.usedKeyHint = apiKey.length > 8
          ? `${apiKey.slice(0, 4)}***${apiKey.slice(-4)}`
          : '(short)';
        data.usedBaseUrl = effectiveBase;
        res.json({ data });
      } catch (error) {
        res.status(400).json({ message: error.message || 'Vision test failed' });
      }
    });

    app.get('/api/settings/github-compat', (req, res) => {
      res.json({ data: { enabled: db.isGithubCompatEnabled() } });
    });

    app.post('/api/settings/github-compat', (req, res) => {
      try {
        const enabled = req.body && req.body.enabled !== undefined
          ? Boolean(req.body.enabled)
          : true;
        res.json({ data: { enabled: db.setGithubCompatEnabled(enabled) } });
      } catch (error) {
        res.status(400).json({ message: error.message || 'Failed to save setting' });
      }
    });

  }

  function registerProfileEnvRoutes(app) {
    app.get('/api/browser-profiles/:id/env', (req, res) => {
      try {
        const id = Number(req.params.id);
        if (!db.getBrowserProfile(id)) return res.status(404).json({ message: 'Profile not found' });
        res.json({ data: db.listEnvEntriesPublic('profile', id) });
      } catch (error) {
        res.status(400).json({ message: error.message || 'Failed to list profile env' });
      }
    });

    app.put('/api/browser-profiles/:id/env', (req, res) => {
      try {
        const id = Number(req.params.id);
        if (!db.getBrowserProfile(id)) return res.status(404).json({ message: 'Profile not found' });
        const entries = normalizeEnvEntriesPayload((req.body || {}).env || (req.body || {}).entries || []);
        res.json({ data: db.replaceEnvEntries('profile', id, entries) });
      } catch (error) {
        res.status(400).json({ message: error.message || 'Failed to save profile env' });
      }
    });

  }

  function registerRunArtifactRoutes(app) {
    app.get('/api/runs/:id/screenshots', (req, res) => {
      const run = db.getRun(Number(req.params.id));
      if (!run) return res.status(404).json({ message: 'Run not found' });
      const items = listRunScreenshots(run);
      res.json({
        data: {
          runId: run.id,
          taskId: run.task_id,
          screenshotsDir: run.screenshots_dir || null,
          count: items.length,
          items,
        },
      });
    });

    app.get('/api/runs/:id/log', (req, res) => {
      const run = db.getRun(Number(req.params.id));
      if (!run) return res.status(404).json({ message: 'Run not found' });
    
      const logPath = run.log_path;
      if (!logPath || !fs.existsSync(logPath)) {
        return res.status(404).json({ message: 'Log file not found' });
      }
    
      const full = String(req.query.full || '') === '1' || String(req.query.full || '') === 'true';
      const tail = Math.min(Math.max(Number(req.query.tail) || 120, 20), 2000);
      const stat = fs.statSync(logPath);
      const hasOffset = req.query.offset !== undefined;
      const offset = Math.max(Number(req.query.offset) || 0, 0);
      const limit = Math.min(Math.max(Number(req.query.limit) || 256 * 1024, 1024), 1024 * 1024);
    
      let content = '';
      let totalLines = 0;
      let chunk = null;
      let snapshotSize = stat.size;
      try {
        if (hasOffset) {
          chunk = readUtf8Chunk(logPath, offset, limit, stat.size);
          content = chunk.content;
          // Segment responses only need a stable byte range; line count is loaded lazily by the UI.
          totalLines = null;
        } else {
          // content / line count / size 必须来自同一个快照。若先 stat 再 readFile，
          // 并发追加会使正文比返回的 size 更新，客户端字节游标随后就会重复读取。
          const snapshot = fs.readFileSync(logPath);
          snapshotSize = snapshot.length;
          const snapshotText = snapshot.toString('utf8');
          const allLines = snapshotText.split(/\r?\n/);
          totalLines = allLines.length;
          content = full ? snapshotText : allLines.slice(Math.max(0, totalLines - tail)).join('\n');
        }
      } catch (error) {
        return res.status(500).json({ message: error.message || 'Failed to read log' });
      }
    
      // 摘要只从当前返回内容提取；分段模式不会为摘要再次扫描整个大文件。
      function extractSection(name, maxLines = 40) {
        const marker = `========== ${name} ==========`;
        const start = content.indexOf(marker);
        if (start < 0) return '';
        const after = content.slice(start);
        const next = after.indexOf('\n========== ', marker.length);
        const body = next > 0 ? after.slice(0, next) : after;
        return body.split(/\r?\n/).slice(0, maxLines).join('\n');
      }
    
      const summaryParts = [
        extractSection('TASK SUMMARY', 30),
        extractSection('DEBUG SUMMARY', 20),
        extractSection('WORKER RESULT PAYLOAD', 40),
      ].filter(Boolean);
      const logHref = `/${String(logPath).replace(/^.*?(logs\/)/, '$1').replace(/\\/g, '/')}`;
      const data = {
        runId: run.id,
        taskId: run.task_id,
        status: run.status,
        errorCode: run.error_code || null,
        startedAt: run.started_at,
        endedAt: run.ended_at,
        logPath,
        logUrl: logHref,
        totalLines,
        tail,
        full,
        summary: summaryParts.join('\n\n'),
        content,
        size: snapshotSize,
      };
      if (chunk) Object.assign(data, chunk);
      res.json({ data });
    });

    app.get('/api/runs/:id/log/download', (req, res) => {
      const run = db.getRun(Number(req.params.id));
      if (!run) return res.status(404).json({ message: 'Run not found' });
      if (!run.log_path || !fs.existsSync(run.log_path)) {
        return res.status(404).json({ message: 'Log file not found' });
      }
      const abs = path.resolve(run.log_path);
      const root = path.resolve(logsDir);
      if (abs !== root && !abs.startsWith(root + path.sep)) {
        return res.status(400).json({ message: 'Invalid log path' });
      }
      return res.download(abs, `run-${run.id}.log`);
    });

    app.get('/api/runs/:id/log/stream', (req, res) => {
      const run = db.getRun(Number(req.params.id));
      if (!run) return res.status(404).json({ message: 'Run not found' });
      if (!run.log_path || !fs.existsSync(run.log_path)) {
        return res.status(404).json({ message: 'Log file not found' });
      }
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      if (typeof res.flushHeaders === 'function') res.flushHeaders();
      if (res.socket && typeof res.socket.setNoDelay === 'function') res.socket.setNoDelay(true);
      const cleanup = logStream.subscribe(run.log_path, res);
      // subscribe 后重新读状态，封住“初始查询仍 running、订阅前任务刚结束”的窗口。
      // 这段是同步执行：若完成发生在重读之后，全局 logStream.end 会命中该客户端。
      const latestRun = db.getRun(run.id) || run;
      if (latestRun.status !== 'running') {
        logStream.endClient(run.log_path, res, { status: latestRun.status });
      }
      res.on('close', cleanup);
    });

    app.post('/api/runs/cleanup', (req, res) => {
      try {
        const data = cleanupStorage(db, {
          dryRun: false,
          retentionDays: 30,
          categories: ['runArtifacts'],
          runningTaskIds: getRunningTaskIds(),
          pruneOldRunRows: true,
        });
        events.emit('runs', { cleanup: true });
        res.json({ ok: data.failures.length === 0, data });
      } catch (error) {
        res.status(400).json({ message: error.message || '运行记录清理失败' });
      }
    });

  }

  return {
    registerPublicRoutes,
    registerEventRoutes,
    registerSettingsRoutes,
    registerProfileEnvRoutes,
    registerRunArtifactRoutes,
  };
}

module.exports = { createSystemRouteRegistrars };
