// SPDX-License-Identifier: GPL-3.0-only
const databaseName = 'navi-local-directory';
const storeName = 'directories';
const directoryKey = 'selected';
const maxEntries = 200;
const maxTextBytes = 32_000;

function openDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(databaseName, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(storeName);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function useDirectoryStore(mode, action) {
  const database = await openDatabase();
  try {
    return await new Promise((resolve, reject) => {
      const transaction = database.transaction(storeName, mode);
      const request = action(transaction.objectStore(storeName));
      transaction.oncomplete = () => resolve(request.result);
      transaction.onabort = () => reject(transaction.error);
    });
  } finally {
    database.close();
  }
}

export const loadDirectory = () => useDirectoryStore('readonly', store => store.get(directoryKey));
export const saveDirectory = directory => useDirectoryStore('readwrite', store => directory
  ? store.put(directory, directoryKey) : store.delete(directoryKey));

export async function directoryPermission(directory) {
  return await directory?.handle.queryPermission({mode:'read'}) === 'granted';
}

export function directoryPath(path, action) {
  if (path === '.' && action === 'list') return [];
  if (typeof path !== 'string' || !path || path.length > 1024 || /[\\:\u0000-\u001f\u007f]/.test(path)) {
    throw new Error('请填写授权目录内的相对路径，列出根目录请使用 .');
  }
  const parts = path.split('/');
  if (parts.length > 32 || parts.some(part => !part || part === '.' || part === '..')) {
    throw new Error('请填写授权目录内的相对路径，列出根目录请使用 .');
  }
  return parts;
}

export async function executeLocalFiles(directoryId, {action,path}) {
  const directory = await loadDirectory();
  if (directory?.id !== directoryId || !await directoryPermission(directory)) {
    return {ok:false, code:'DIRECTORY_PERMISSION', message:'本地目录已更换、断开或需要重新授权。'};
  }

  const parts = directoryPath(path, action);
  const filename = action === 'read' ? parts.pop() : null;
  let handle = directory.handle;
  try {
    for (const part of parts) handle = await handle.getDirectoryHandle(part);
    if (action === 'list') {
      const entries = [];
      for await (const [name, child] of handle.entries()) {
        if (entries.length === maxEntries) return {ok:true, path, entries, truncated:true};
        entries.push({name, kind:child.kind});
      }
      return {ok:true, path, entries, truncated:false};
    }

    const file = await (await handle.getFileHandle(filename)).getFile();
    const truncated = file.size > maxTextBytes;
    const data = await file.slice(0, maxTextBytes).arrayBuffer();
    let text;
    try {
      text = new TextDecoder('utf-8', {fatal:true}).decode(data, {stream:truncated});
    } catch {
      return {ok:false, message:'此文件无法作为 UTF-8 文本读取。'};
    }
    if (/[\u0000-\u0008\u000e-\u001f]/.test(text)) return {ok:false, message:'此文件无法作为 UTF-8 文本读取。'};
    return {ok:true, path, text, truncated};
  } catch (error) {
    if (error.name === 'NotAllowedError' || error.name === 'SecurityError') {
      return {ok:false, code:'DIRECTORY_PERMISSION', message:'浏览器拒绝访问，请重新授权本地目录。'};
    }
    if (error.name === 'NotFoundError' || error.name === 'TypeMismatchError') {
      return {ok:false, message:'没有找到对应的文件或目录，请核对相对路径。'};
    }
    return {ok:false, message:'浏览器暂时无法读取此路径。'};
  }
}
