import { useState, useEffect, useRef } from 'react';

// 破坏性升级时改这个前缀：全部持久化数据一起作废。
const NS = 'tf.v1.';

// localStorage 持久化 state：键带命名空间与版本号前缀。
// 存的 JSON 损坏或解析失败时回退到 initial，不抛错。initial 可以是值或惰性工厂函数。
// rehydrate(parsed) 在读回时清洗存下的值（重置瞬时标志、截断数组之类）。
export function usePersistentState(key, initial, options = {}) {
  const { rehydrate } = options;
  const storageKey = NS + key;

  // 存最新的 rehydrate 引用：改了它不用重跑初始化函数。
  const rehydrateRef = useRef(rehydrate);
  rehydrateRef.current = rehydrate;

  const makeInitial = () => (typeof initial === 'function' ? initial() : initial);

  const [val, setVal] = useState(() => {
    try {
      const s = localStorage.getItem(storageKey);
      if (s === null) return makeInitial();
      const parsed = JSON.parse(s);
      return rehydrateRef.current ? rehydrateRef.current(parsed) : parsed;
    } catch {
      return makeInitial();
    }
  });

  useEffect(() => {
    try {
      localStorage.setItem(storageKey, JSON.stringify(val));
    } catch {
    // 配额超了或存储不可用：忽略写入，不打断界面。
    }
  }, [storageKey, val]);

  return [val, setVal];
}
