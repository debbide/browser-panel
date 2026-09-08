(function exposeFileBrowserController(global) {
  function create(deps = {}) {
    const api = deps.api || global.FileBrowserApi;
    const view = deps.view || global.FileBrowserView;
    const actions = deps.actions || {};
    let mounted = false;
    let fsCurrentPath = '';
    const fetchJson = global.fetchJson;
    const escapeHtml = global.escapeHtml;
    const formatFsMtime = view.formatMtime;
    const formatBytes = view.formatBytes;
    const promptFsName = view.promptFsName || global.promptFsName;
    const toast = actions.toast || global.toast;
    const dialogConfirm = actions.dialogConfirm || global.dialogConfirm;
    const loadScripts = actions.loadScripts || global.loadScripts;
    const pathBasename = actions.pathBasename || global.pathBasename;
    const document = global.document;
    const window = global;
    const btoa = global.btoa;


    function fsBreadcrumb(rel) {
      const el = document.getElementById('fs-breadcrumb');
      if (!el) return;
      el.innerHTML = `<code>tasks/${escapeHtml(rel || '')}${rel ? '/' : ''}</code>`;
    }

    async function loadTasksFs(dir = fsCurrentPath) {
      const list = document.getElementById('fs-list');
      if (!list) return;
      fsCurrentPath = String(dir || '').replace(/^\/+|\/+$/g, '');
      fsBreadcrumb(fsCurrentPath);
      list.innerHTML = '<div class="files-list-empty">加载中…</div>';
      try {
        const q = fsCurrentPath ? `?path=${encodeURIComponent(fsCurrentPath)}` : '';
        const res = await fetchJson(`/api/tasks-fs${q}`);
        const entries = res.data?.entries || [];
        if (!entries.length) {
          list.innerHTML = '<div class="files-list-empty">空目录</div>';
          return;
        }
        list.innerHTML = '';
        // Column header (name / size / mtime / actions)
        const head = document.createElement('div');
        head.className = 'files-row files-row-head';
        head.innerHTML = `
          <span></span>
          <div class="files-name">名称</div>
          <div class="files-meta">大小</div>
          <div class="files-mtime">修改时间</div>
          <div class="files-actions"></div>
        `;
        list.appendChild(head);
        for (const ent of entries) {
          const row = document.createElement('div');
          row.className = `files-row ${ent.type === 'dir' ? 'is-dir' : ''}`;
          const icon = ent.type === 'dir' ? 'folder' : 'file-code';
          const mtimeLabel = formatFsMtime(ent.mtime);
          const sizeLabel = ent.type === 'dir' ? '文件夹' : formatBytes(ent.size);
          row.innerHTML = `
            <i data-lucide="${icon}" class="icon-sm" style="opacity:.85"></i>
            <div class="files-name" title="${escapeHtml(ent.name)}">${escapeHtml(ent.name)}</div>
            <div class="files-meta">${escapeHtml(sizeLabel)}</div>
            <div class="files-mtime" title="${escapeHtml(ent.mtime || '')}">${escapeHtml(mtimeLabel)}</div>
            <div class="files-actions"></div>
          `;
          const rowActions = row.querySelector('.files-actions');
          if (ent.type === 'dir') {
            row.addEventListener('click', (e) => {
              if (e.target.closest('button')) return;
              loadTasksFs(ent.path);
            });
          } else {
            if (ent.text) {
              const editBtn = document.createElement('button');
              editBtn.type = 'button';
              editBtn.className = 'alt';
              editBtn.textContent = '编辑';
              editBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                openTasksFileEditor(ent.path);
              });
              rowActions.appendChild(editBtn);
            }
            const dlBtn = document.createElement('button');
            dlBtn.type = 'button';
            dlBtn.className = 'alt';
            dlBtn.textContent = '下载';
            dlBtn.addEventListener('click', (e) => {
              e.stopPropagation();
              window.open(`/api/tasks-fs/download?path=${encodeURIComponent(ent.path)}`, '_blank');
            });
            rowActions.appendChild(dlBtn);
          }
          const delBtn = document.createElement('button');
          delBtn.type = 'button';
          delBtn.className = 'alt danger';
          delBtn.textContent = '删除';
          delBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            dialogConfirm(`确定删除「${ent.name}」？`, async () => {
              try {
                await fetchJson('/api/tasks-fs', {
                  method: 'DELETE',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ path: ent.path }),
                });
                toast('已删除', 'success');
                await loadTasksFs(fsCurrentPath);
                await loadScripts();
              } catch (err) {
                toast(err.message || '删除失败', 'error');
              }
            });
          });
          rowActions.appendChild(delBtn);
          list.appendChild(row);
        }
        if (window.lucide) window.lucide.createIcons({ root: list });
      } catch (error) {
        list.innerHTML = `<div class="files-list-empty">${escapeHtml(error.message || '加载失败')}</div>`;
      }
    }

    function openTasksFileEditor(relPath) {
      fetchJson(`/api/tasks-fs/read?path=${encodeURIComponent(relPath)}`)
        .then((res) => {
          const file = res.data || {};
          const mask = document.createElement('div');
          mask.className = 'modal-mask open';
          mask.style.zIndex = '10050';
          const dialog = document.createElement('div');
          dialog.className = 'modal open files-editor-dialog';
          dialog.style.cssText = 'z-index:10051; max-width:860px; width:min(860px,96vw);';
          dialog.innerHTML = `
            <div class="modal-header">
              <div>
                <h2>编辑 ${escapeHtml(file.name || relPath)}</h2>
                <p class="muted" style="margin:4px 0 0;font-size:13px;"><code>tasks/${escapeHtml(relPath)}</code></p>
              </div>
              <button type="button" class="icon-btn fs-ed-close" aria-label="关闭"><i data-lucide="x" class="icon-md"></i></button>
            </div>
            <div class="modal-body">
              <textarea class="files-editor-area" spellcheck="false"></textarea>
              <div class="row" style="margin-top:12px; gap:8px; justify-content:flex-end;">
                <button type="button" class="alt fs-ed-cancel">取消</button>
                <button type="button" class="btn-primary fs-ed-save">保存</button>
              </div>
            </div>
          `;
          document.body.appendChild(mask);
          document.body.appendChild(dialog);
          const area = dialog.querySelector('.files-editor-area');
          area.value = file.content || '';
          if (window.lucide) window.lucide.createIcons({ root: dialog });
          const close = () => { mask.remove(); dialog.remove(); };
          dialog.querySelector('.fs-ed-close').addEventListener('click', close);
          dialog.querySelector('.fs-ed-cancel').addEventListener('click', close);
          mask.addEventListener('click', close);
          dialog.querySelector('.fs-ed-save').addEventListener('click', async () => {
            try {
              await fetchJson('/api/tasks-fs/write', {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ path: relPath, content: area.value }),
              });
              toast('已保存', 'success');
              close();
              await loadTasksFs(fsCurrentPath);
            } catch (err) {
              toast(err.message || '保存失败', 'error');
            }
          });
          setTimeout(() => area.focus(), 40);
        })
        .catch((err) => toast(err.message || '读取失败', 'error'));
    }

    function wireTasksFsUi() {
        if (mounted) return;
        mounted = true;
      const up = document.getElementById('fs-btn-up');
      const refresh = document.getElementById('fs-btn-refresh');
      const newFile = document.getElementById('fs-btn-new-file');
      const newFolder = document.getElementById('fs-btn-new-folder');
      const uploadBtn = document.getElementById('fs-btn-upload');
      const uploadInput = document.getElementById('fs-upload-input');

      if (up) {
        up.addEventListener('click', () => {
          if (!fsCurrentPath) return;
          const parts = fsCurrentPath.split('/').filter(Boolean);
          parts.pop();
          loadTasksFs(parts.join('/'));
        });
      }
      if (refresh) refresh.addEventListener('click', () => loadTasksFs(fsCurrentPath));
      if (newFolder) {
        newFolder.addEventListener('click', async () => {
          const name = await promptFsName('新建文件夹', 'folder-name');
          if (!name) return;
          try {
            await fetchJson('/api/tasks-fs/mkdir', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ parent: fsCurrentPath, name }),
            });
            toast('文件夹已创建', 'success');
            await loadTasksFs(fsCurrentPath);
          } catch (err) {
            toast(err.message || '创建失败', 'error');
          }
        });
      }
      if (newFile) {
        newFile.addEventListener('click', async () => {
          const name = await promptFsName('新建文件', 'script.js');
          if (!name) return;
          try {
            const created = await fetchJson('/api/tasks-fs/create-file', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ parent: fsCurrentPath, name, content: '' }),
            });
            toast('文件已创建', 'success');
            await loadTasksFs(fsCurrentPath);
            await loadScripts();
            if (created.data?.path) openTasksFileEditor(created.data.path);
          } catch (err) {
            toast(err.message || '创建失败', 'error');
          }
        });
      }
      async function fileToBase64(file) {
        const buf = await file.arrayBuffer();
        const bytes = new Uint8Array(buf);
        let binary = '';
        const chunk = 0x8000;
        for (let i = 0; i < bytes.length; i += chunk) {
          binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
        }
        return btoa(binary);
      }

      /** Relative path for upload: folder pick keeps webkitRelativePath tree. */
      function uploadRelativePath(file) {
        const rel = String(file.webkitRelativePath || file.name || '')
          .replace(/\\/g, '/')
          .replace(/^\/+/, '');
        if (!rel || rel.includes('..')) return file.name || '';
        // Skip junk paths from OS folder pickers
        const parts = rel.split('/').filter(Boolean);
        if (parts.some((p) => p === '__pycache__' || p === '.git' || p === 'node_modules' || p === '.DS_Store')) {
          return '';
        }
        if (parts.some((p) => p.endsWith('.pyc') || p === 'Thumbs.db')) return '';
        return parts.join('/');
      }

      async function uploadFilesList(fileList, { asFolder = false } = {}) {
        const files = [...(fileList || [])];
        if (!files.length) return;
        let ok = 0;
        let fail = 0;
        let skip = 0;
        const total = files.length;
        if (total > 1) toast(`开始上传 ${total} 个文件…`, 'info');
        for (const file of files) {
          const rel = uploadRelativePath(file);
          if (!rel) {
            skip += 1;
            continue;
          }
          // Flat multi-file: only basename; folder mode: keep relative path
          const relativePath = asFolder ? rel : pathBasename(rel);
          try {
            const b64 = await fileToBase64(file);
            await fetchJson('/api/tasks-fs/upload', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                parent: fsCurrentPath,
                name: pathBasename(relativePath),
                relativePath,
                encoding: 'base64',
                content: b64,
              }),
            });
            ok += 1;
          } catch (err) {
            fail += 1;
            toast(`${relativePath}: ${err.message || '上传失败'}`, 'error');
          }
        }
        if (ok && !fail) {
          toast(
            asFolder
              ? `文件夹上传完成：${ok} 个文件${skip ? `，跳过 ${skip}` : ''}`
              : (ok === 1 ? `已上传 ${files[0]?.name || ''}` : `已上传 ${ok} 个文件`),
            'success',
          );
        } else if (ok && fail) {
          toast(`上传结束：成功 ${ok}，失败 ${fail}${skip ? `，跳过 ${skip}` : ''}`, 'warn');
        } else if (!ok && fail) {
          toast(`上传失败（${fail}）`, 'error');
        } else if (skip && !ok) {
          toast('没有可上传的文件（可能全是缓存/系统目录）', 'warn');
        }
        await loadTasksFs(fsCurrentPath);
        await loadScripts();
      }

      if (uploadBtn && uploadInput) {
        uploadBtn.addEventListener('click', () => {
          uploadInput.removeAttribute('webkitdirectory');
          uploadInput.removeAttribute('directory');
          uploadInput.click();
        });
        uploadInput.addEventListener('change', async () => {
          const files = [...(uploadInput.files || [])];
          uploadInput.value = '';
          await uploadFilesList(files, { asFolder: false });
        });
      }

      const uploadFolderBtn = document.getElementById('fs-btn-upload-folder');
      const uploadFolderInput = document.getElementById('fs-upload-folder-input');
      if (uploadFolderBtn && uploadFolderInput) {
        uploadFolderBtn.addEventListener('click', () => uploadFolderInput.click());
        uploadFolderInput.addEventListener('change', async () => {
          const files = [...(uploadFolderInput.files || [])];
          uploadFolderInput.value = '';
          await uploadFilesList(files, { asFolder: true });
        });
      }

    }

    function mount() {
      wireTasksFsUi();
    }

    function unmount() {}

    function load(nextPath = fsCurrentPath) {
      return loadTasksFs(nextPath);
    }

    function currentPath() {
      return fsCurrentPath;
    }

    return { mount, unmount, load, currentPath, openFileEditor: openTasksFileEditor };
  }

  global.FileBrowserController = { create };
})(window);
