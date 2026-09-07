/* =========================================================
 * IndexedDB 存取层（原生 API，无第三方依赖）
 * 引入位置：必须在 assets/app.js 之前加载（index.html 中已排序）。
 * 作用：把多项目历史库从 localStorage（~5MB 上限）迁移到 IndexedDB
 *      （数百 MB~2GB），突破容量限制；localStorage 仅作不可用时的回退。
 * 设计：
 *   - store `projects`：keyPath='id'，每条记录 = 一个完整项目快照
 *   - store `meta`：keyPath='k'，固定记录 {k:'root', curId} 指向当前项目
 *   - 所有方法返回 Promise，便于 app.js 以 fire-and-forget 或 await 调用
 * ========================================================= */
'use strict';

const IDB_NAME  = 'fyp_db';
const IDB_STORE = 'projects';   // 项目快照库
const IDB_META  = 'meta';       // 当前项目指针
const IDB_VERSION = 1;

// 缓存 open 的 Promise，避免重复打开
let _idbReady = null;

// 同步判断：当前环境是否支持 IndexedDB（不支持则 app.js 回退 localStorage）
function idbAvailable(){
  try{ return (typeof indexedDB !== 'undefined') && !!indexedDB; }
  catch(e){ return false; }
}

// 打开（或创建）数据库；首次建库时创建两个 object store
function idbOpen(){
  if(_idbReady) return _idbReady;
  _idbReady = new Promise(function(resolve, reject){
    if(!idbAvailable()){ reject(new Error('indexeddb-unavailable')); return; }
    let req;
    try{ req = indexedDB.open(IDB_NAME, IDB_VERSION); }
    catch(e){ reject(e); return; }
    req.onupgradeneeded = function(ev){
      const db = ev.target.result;
      if(!db.objectStoreNames.contains(IDB_STORE)) db.createObjectStore(IDB_STORE, { keyPath: 'id' });
      if(!db.objectStoreNames.contains(IDB_META))  db.createObjectStore(IDB_META,  { keyPath: 'k'  });
    };
    req.onsuccess = function(ev){ resolve(ev.target.result); };
    req.onerror   = function(ev){ reject(ev.target.error || new Error('idb-open-error')); };
  });
  return _idbReady;
}

// 统一的事务封装：mode = 'readonly' | 'readwrite'
function _idbTx(store, mode){
  return idbOpen().then(function(db){ return db.transaction(store, mode).objectStore(store); });
}

// 写单个项目记录（含 id 字段）
function idbPut(item){
  return _idbTx(IDB_STORE, 'readwrite').then(function(store){
    return new Promise(function(resolve, reject){
      const tx = store.transaction;
      store.put(item);
      tx.oncomplete = function(){ resolve(true); };
      tx.onerror    = function(){ reject(tx.error || new Error('idb-put-error')); };
      tx.onabort    = function(){ reject(tx.error || new Error('idb-put-abort')); };
    });
  });
}

// 删除单个项目记录
function idbDelete(id){
  return _idbTx(IDB_STORE, 'readwrite').then(function(store){
    return new Promise(function(resolve, reject){
      const tx = store.transaction;
      store.delete(id);
      tx.oncomplete = function(){ resolve(true); };
      tx.onerror    = function(){ reject(tx.error || new Error('idb-del-error')); };
    });
  });
}

// 读单个项目记录
function idbGet(id){
  return _idbTx(IDB_STORE, 'readonly').then(function(store){
    return new Promise(function(resolve, reject){
      const req = store.get(id);
      req.onsuccess = function(){ resolve(req.result || null); };
      req.onerror   = function(){ reject(req.error || new Error('idb-get-error')); };
    });
  });
}

// 读全部项目记录（返回数组，无序——调用方自行按 updatedAt 排序）
function idbList(){
  return _idbTx(IDB_STORE, 'readonly').then(function(store){
    return new Promise(function(resolve, reject){
      const req = store.getAll();
      req.onsuccess = function(){ resolve(Array.isArray(req.result) ? req.result : []); };
      req.onerror   = function(){ reject(req.error || new Error('idb-list-error')); };
    });
  });
}

// 写当前项目指针（curId）
function idbPutMeta(curId){
  return _idbTx(IDB_META, 'readwrite').then(function(store){
    return new Promise(function(resolve, reject){
      const tx = store.transaction;
      store.put({ k:'root', curId: (curId == null ? null : curId) });
      tx.oncomplete = function(){ resolve(true); };
      tx.onerror    = function(){ reject(tx.error || new Error('idb-meta-error')); };
    });
  });
}

// 读当前项目指针（curId）
function idbGetMeta(){
  return _idbTx(IDB_META, 'readonly').then(function(store){
    return new Promise(function(resolve, reject){
      const req = store.get('root');
      req.onsuccess = function(){ resolve(req.result ? req.result.curId : null); };
      req.onerror   = function(){ reject(req.error || new Error('idb-meta-get-error')); };
    });
  });
}

// 批量写全库（迁移 / 导入 / 整库落盘用）：清空后写入全部项目 + 当前指针
function idbPutAll(items, curId){
  return idbOpen().then(function(db){
    return new Promise(function(resolve, reject){
      const tx = db.transaction([IDB_STORE, IDB_META], 'readwrite');
      const store = tx.objectStore(IDB_STORE);
      store.clear();
      (items || []).forEach(function(it){ store.put(it); });
      if(curId != null) tx.objectStore(IDB_META).put({ k:'root', curId: curId });
      tx.oncomplete = function(){ resolve(true); };
      tx.onerror    = function(){ reject(tx.error || new Error('idb-putall-error')); };
      tx.onabort    = function(){ reject(tx.error || new Error('idb-putall-abort')); };
    });
  });
}
