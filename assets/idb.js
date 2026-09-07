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

// ===== 存储命名空间（v1.0.221，方案B：多站隔离） =====
// 同一 origin 下不同部署路径共享 localStorage / IndexedDB，会造成多站数据串流。
// 以当前部署路径的第一段（GitHub Pages 即仓库名）派生命名空间，各站读写各自独立、互不干扰。
// 例如 /tellme123-main/ 与 /tellme123-v2/ → ns 分别为 tellme123_main / tellme123_v2。
// 冷升级时 app.js 会把旧「共享裸 key（fyp_*）」复制一份进本命名空间作为起点（详见 app.js migrateSharedOnce）。
const IDB_NAME        = 'fyp_' + storageNs() + '_db';
const IDB_LEGACY_NAME = 'fyp_db';   // 旧版共享库名，仅用于一次性迁移
const IDB_STORE = 'projects';   // 项目快照库
const IDB_META  = 'meta';       // 当前项目指针
const IDB_VERSION = 1;

// 基于当前部署路径派生命名空间前缀；与 app.js 完全同源逻辑。
function storageNs(){
  try{
    const p = String(location.pathname || '/').replace(/^\/+|\/+$/g, '');
    const seg = (p.split('/')[0] || 'root').toLowerCase().replace(/[^a-z0-9_]/g, '_').slice(0, 32);
    return seg || 'root';
  }catch(e){ return 'root'; }
}
// 把裸 key 转成当前命名空间下的实际存储 key（localStorage 与本文件 IDB 共用同一前缀）
function nsKey(bare){ return storageNs() + '_' + bare; }

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

// 读旧共享库（IDB_LEGACY_NAME=fyp_db）全部项目（v1.0.221 方案B：冷升级一次性迁移用）。
// 旧版多站在同一 fyp_db 库读写；升级后各站用各自的 <ns>_db，此函数仅供迁移时读取旧数据一次。
function idbListLegacy(){
  return new Promise(function(resolve, reject){
    if(!idbAvailable()){ resolve([]); return; }
    let req;
    try{ req = indexedDB.open(IDB_LEGACY_NAME, IDB_VERSION); }
    catch(e){ resolve([]); return; }
    req.onupgradeneeded = function(){};   // 只读不建库
    req.onsuccess = function(ev){
      const db = ev.target.result;
      try{
        if(!db.objectStoreNames.contains(IDB_STORE)){ db.close(); resolve([]); return; }
        const tx = db.transaction(IDB_STORE, 'readonly');
        const store = tx.objectStore(IDB_STORE);
        const g = store.getAll();
        g.onsuccess = function(){
          const list = Array.isArray(g.result) ? g.result : [];
          try{ db.close(); }catch(e){}
          resolve(list);
        };
        g.onerror = function(){
          try{ db.close(); }catch(e){}
          resolve([]);
        };
      }catch(e){
        try{ db.close(); }catch(e){}
        resolve([]);
      }
    };
    req.onerror = function(){ resolve([]); };
    req.onblocked = function(){ resolve([]); };
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
