(() => {
  const folderPaths = (nodes) => {
    const paths = [];
    for (const node of nodes || []) {
      if (node.type === "folder") paths.push(node.path);
      if (node.children) paths.push(...folderPaths(node.children));
    }
    return paths;
  };

  function restore(nodes, storedValue) {
    const valid = new Set(folderPaths(nodes));
    // On first run show the first level, rather than either hiding everything or
    // expanding an arbitrarily large vault. A saved empty array is intentional.
    if (storedValue == null) {
      return new Set((nodes || []).filter((node) => node.type === "folder").map((node) => node.path));
    }
    let paths;
    try {
      paths = typeof storedValue === "string" ? JSON.parse(storedValue) : storedValue;
    } catch {
      paths = null;
    }
    if (!Array.isArray(paths)) return new Set();
    return new Set(paths.filter((path) => typeof path === "string" && valid.has(path)));
  }

  function remap(paths, from, to) {
    const next = new Set();
    for (const path of paths || []) {
      next.add(path === from || path.startsWith(`${from}/`) ? to + path.slice(from.length) : path);
    }
    return next;
  }

  const legacyKey = "lumen-workspace-expanded-folders";
  const storageKey = (root) => `${legacyKey}:${encodeURIComponent(root)}`;

  function saveForVault(storage, root, paths) {
    try { storage.setItem(storageKey(root), JSON.stringify([...paths].sort())); } catch {}
  }

  function restoreForVault(storage, root, nodes) {
    let stored = null;
    try {
      stored = storage.getItem(storageKey(root));
      // Assign the old single-vault preference once; never copy it into a new vault.
      if (!storage.getItem(`${legacyKey}:owner`)) {
        storage.setItem(`${legacyKey}:owner`, root);
        if (stored === null) stored = storage.getItem(legacyKey);
      }
    } catch {}
    const paths = restore(nodes, stored);
    saveForVault(storage, root, paths);
    return paths;
  }

  const api = { folderPaths, restore, remap, storageKey, saveForVault, restoreForVault };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (typeof window !== "undefined") window.DMTreeState = api;
})();
