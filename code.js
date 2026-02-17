const UI_WIDTH = 380;
const UI_HEIGHT = 664;
const STORAGE_KEY = "planet-icon-config-v1";
const ICON_TINT_RGB = {
  r: 69 / 255,
  g: 90 / 255,
  b: 100 / 255
};
const NODE_META_KEY_MANAGED = "pi-managed";
const NODE_META_KEY_PROVIDER = "pi-provider";
const NODE_META_KEY_ICON_ID = "pi-icon-id";
const NODE_META_KEY_PATH = "pi-path";
const NODE_META_KEY_BASE_NAME = "pi-base-name";
const NODE_META_KEY_VARIANT = "pi-variant";
const NODE_META_KEY_SIZE = "pi-size";

const DEFAULT_CONFIG = {
  selectedProvider: null,
  providers: {
    azure: {
      connected: false,
      organizationUrl: "",
      project: "",
      pat: "",
      repository: "",
      branch: "main"
    },
    github: {
      connected: false,
      pat: "",
      repository: "",
      branch: "main"
    }
  }
};

const runtime = {
  config: clone(DEFAULT_CONFIG),
  iconsByProvider: {
    azure: [],
    github: []
  },
  descriptorsByProvider: {
    azure: new Map(),
    github: new Map()
  },
  svgCacheById: new Map(),
  syncToken: 0
};

const ready = loadStoredConfig();

figma.showUI(__html__, {
  width: UI_WIDTH,
  height: UI_HEIGHT,
  themeColors: true
});

figma.ui.onmessage = async (message) => {
  try {
    await ready;

    if (!message || typeof message.type !== "string") {
      return;
    }

    if (message.type === "resize-ui") {
      const width = Number.isFinite(message.width) ? message.width : UI_WIDTH;
      const height = Number.isFinite(message.height) ? message.height : UI_HEIGHT;
      figma.ui.resize(width, height);
      return;
    }

    if (message.type === "close-plugin") {
      figma.closePlugin();
      return;
    }

    if (message.type === "ui-ready") {
      await handleUiReady();
      return;
    }

    if (message.type === "save-provider") {
      await handleSaveProvider(message);
      return;
    }

    if (message.type === "select-provider") {
      await handleSelectProvider(message);
      return;
    }

    if (message.type === "retry-sync") {
      await handleRetrySync();
      return;
    }

    if (message.type === "insert-icon") {
      await handleInsertIcon(message);
      return;
    }

    if (message.type === "apply-selected-icon-variant-size") {
      await handleApplySelectedIconVariantSize(message);
      return;
    }

    if (message.type === "fetch-icon-previews") {
      await handleFetchIconPreviews(message);
    }
  } catch (error) {
    const details = getErrorMessage(error);
    figma.notify(`Planet Icon error: ${details}`);
  }
};

async function handleUiReady() {
  const selected = ensureSelectedProvider();
  await persistConfig();
  postHydration();
  if (!selected) {
    return;
  }
  await syncProvider(selected, "startup");
}

async function handleSaveProvider(message) {
  const provider = normalizeProvider(message.provider);
  if (!provider) {
    throw new Error("Invalid provider.");
  }

  const current = runtime.config.providers[provider];
  const incoming = message.values && typeof message.values === "object" ? message.values : {};
  const merged = normalizeProviderConfig(
    provider,
    Object.assign({}, current, incoming, {
      connected: true
    })
  );

  runtime.config.providers[provider] = merged;

  const shouldSelectProvider = Boolean(message.setSelectedProvider);
  if (shouldSelectProvider || !runtime.config.selectedProvider) {
    runtime.config.selectedProvider = provider;
  }

  ensureSelectedProvider();
  await persistConfig();
  postHydration();

  if (runtime.config.selectedProvider === provider) {
    await syncProvider(provider, "save-provider");
  }
}

async function handleSelectProvider(message) {
  const provider = normalizeProvider(message.provider);
  if (!provider) {
    throw new Error("Invalid provider.");
  }

  if (!runtime.config.providers[provider].connected) {
    throw new Error("Provider is not configured yet.");
  }

  runtime.config.selectedProvider = provider;
  await persistConfig();
  postHydration();
  await syncProvider(provider, "select-provider");
}

async function handleRetrySync() {
  const provider = ensureSelectedProvider();
  await persistConfig();
  postHydration();
  if (!provider) {
    postToUi(
      Object.assign(
        {
          type: "remote-fetch-failed",
          context: "retry-sync",
          error: "No provider is configured."
        },
        publicState()
      )
    );
    return;
  }
  await syncProvider(provider, "retry-sync");
}

async function handleInsertIcon(message) {
  const iconId = normalizeString(message.iconId);
  const requestedSize = Number(message.size);
  const targetSize =
    Number.isFinite(requestedSize) && requestedSize > 0 ? Math.round(requestedSize) : null;
  if (!iconId) {
    figma.notify("Please choose an icon first.");
    return;
  }

  const provider = normalizeProvider(iconId.split(":")[0]);
  if (!provider) {
    figma.notify("Invalid icon id. Please sync again.");
    return;
  }

  const descriptor = runtime.descriptorsByProvider[provider].get(iconId);
  if (!descriptor) {
    figma.notify("Icon metadata not found. Please sync again.");
    return;
  }

  try {
    const svg = await getSvgMarkup(iconId, descriptor);
    const sizedSvg = targetSize ? withSvgSize(svg, targetSize) : svg;
    const node = figma.createNodeFromSvg(sizedSvg);
    applyNodeTint(node, ICON_TINT_RGB);
    if (targetSize && Math.abs(nodeNominalSize(node) - targetSize) >= 1) {
      resizeNodeToTarget(node, targetSize);
    }
    const requestedVariant = normalizeVariantLabel(message.variant);
    const sourceName = normalizeString(message.name) || iconNameFromPath(descriptor.path);
    const parsed = extractIconBaseAndVariant(sourceName);
    const variant = requestedVariant || parsed.variant || "outline";
    const nodeName = formatIconName(parsed.baseName || sourceName || "Icon", variant);

    node.name = nodeName;
    setIconNodeMetadata(node, {
      provider,
      iconId,
      path: descriptor.path,
      baseName: parsed.baseName || sourceName || "Icon",
      variant,
      size: targetSize || nodeNominalSize(node)
    });
    const center = figma.viewport.center;
    node.x = center.x - node.width / 2;
    node.y = center.y - node.height / 2;

    if (node.parent !== figma.currentPage) {
      figma.currentPage.appendChild(node);
    }

    figma.currentPage.selection = [node];
    figma.viewport.scrollAndZoomIntoView([node]);
    figma.notify(`Inserted ${nodeName}`);
  } catch (error) {
    figma.notify(`Failed to insert icon: ${getErrorMessage(error)}`);
  }
}

async function handleApplySelectedIconVariantSize(message) {
  const requestedVariant = normalizeVariantLabel(message.variant);
  const requestedSize = Number(message.size);
  const targetSize =
    Number.isFinite(requestedSize) && requestedSize > 0 ? Math.round(requestedSize) : null;

  if (!requestedVariant && !targetSize) {
    return;
  }

  const selection = Array.isArray(figma.currentPage.selection) ? figma.currentPage.selection : [];
  if (!selection.length) {
    return;
  }

  const updatedNodes = [];
  let missingVariantCount = 0;

  for (let index = 0; index < selection.length; index += 1) {
    const node = selection[index];
    const updated = await applyVariantSizeToNode(node, requestedVariant, targetSize);
    if (!updated) {
      continue;
    }
    if (updated.error === "variant-missing") {
      missingVariantCount += 1;
      continue;
    }
    updatedNodes.push(updated.node);
  }

  if (updatedNodes.length) {
    figma.currentPage.selection = updatedNodes;
  }

  if (missingVariantCount > 0) {
    figma.notify("Some selected icons do not have that variant.");
  }
}

async function applyVariantSizeToNode(node, requestedVariant, requestedSize) {
  const details = resolveNodeIconDetails(node);
  if (!details) {
    return null;
  }

  const currentVariant = details.variant || "outline";
  const desiredVariant = requestedVariant || currentVariant;
  const desiredSize = requestedSize || nodeNominalSize(node) || details.size || null;

  let target = details;
  if (desiredVariant !== currentVariant) {
    const variantMatch = findDescriptorByBaseAndVariant(details.provider, details.baseName, desiredVariant);
    if (!variantMatch) {
      return { error: "variant-missing", node };
    }
    target = variantMatch;
  }

  const nextName = formatIconName(target.baseName, target.variant || desiredVariant);
  const resolvedName = formatIconName(target.baseName, target.variant || desiredVariant);
  const currentSize = nodeNominalSize(node) || details.size || 0;
  const nextSize = desiredSize || currentSize || 24;
  const isDescriptorChange = details.iconId !== target.iconId;
  const isSizeChange = currentSize > 0 && Math.abs(currentSize - nextSize) >= 1;

  if (!isDescriptorChange && !isSizeChange) {
    node.name = resolvedName;
    setIconNodeMetadata(node, {
      provider: target.provider,
      iconId: target.iconId,
      path: target.path,
      baseName: target.baseName,
      variant: target.variant || desiredVariant,
      size: nextSize || nodeNominalSize(node)
    });
    return { node };
  }

  const svg = await getSvgMarkup(target.iconId, target.descriptor);
  const replacement = figma.createNodeFromSvg(withSvgSize(svg, nextSize));
  applyNodeTint(replacement, ICON_TINT_RGB);
  const parent = node.parent;
  if (!parent) {
    return null;
  }

  const oldX = Number(node.x);
  const oldY = Number(node.y);
  const oldWidth = Number(node.width);
  const oldHeight = Number(node.height);
  const centerX = oldX + oldWidth / 2;
  const centerY = oldY + oldHeight / 2;
  const oldIndex = parent.children.indexOf(node);

  if (nextSize && Math.abs(nodeNominalSize(replacement) - nextSize) >= 1) {
    resizeNodeToTarget(replacement, nextSize);
  }

  trySetNodePositionByCenter(replacement, centerX, centerY);
  copyNodeVisualState(node, replacement);

  if (oldIndex >= 0) {
    parent.insertChild(oldIndex, replacement);
  } else {
    parent.appendChild(replacement);
  }

  replacement.name = resolvedName;
  setIconNodeMetadata(replacement, {
    provider: target.provider,
    iconId: target.iconId,
    path: target.path,
    baseName: target.baseName,
    variant: target.variant || desiredVariant,
    size: nextSize || nodeNominalSize(replacement)
  });

  node.remove();
  return { node: replacement };
}

async function handleFetchIconPreviews(message) {
  const incoming = Array.isArray(message.iconIds) ? message.iconIds : [];
  const requestedIds = [];
  const seen = new Set();

  for (let index = 0; index < incoming.length; index += 1) {
    const iconId = normalizeString(incoming[index]);
    if (!iconId || seen.has(iconId)) {
      continue;
    }
    seen.add(iconId);
    requestedIds.push(iconId);
    if (requestedIds.length >= 24) {
      break;
    }
  }

  const queue = requestedIds.slice();
  const workerCount = Math.max(1, Math.min(8, queue.length));

  const runWorker = async () => {
    while (queue.length) {
      const iconId = queue.shift();
      if (!iconId) {
        continue;
      }

      let svgMarkup = "";
      let previewError = "";

      try {
        const descriptor = getDescriptorByIconId(iconId);
        if (descriptor) {
          svgMarkup = await getSvgMarkup(iconId, descriptor);
        } else {
          previewError = "Icon descriptor not found.";
        }
      } catch (error) {
        svgMarkup = "";
        previewError = getErrorMessage(error);
      }

      postToUi({
        type: "icon-preview",
        iconId,
        svgMarkup,
        error: previewError
      });
    }
  };

  const workers = [];
  for (let index = 0; index < workerCount; index += 1) {
    workers.push(runWorker());
  }
  await Promise.all(workers);

  postToUi({
    type: "icon-previews-complete",
    requestedIds
  });
}

async function syncProvider(provider, context) {
  const normalizedProvider = normalizeProvider(provider);
  if (!normalizedProvider) {
    return;
  }

  const providerConfig = runtime.config.providers[normalizedProvider];
  if (!providerConfig || !providerConfig.connected) {
    return;
  }

  const token = ++runtime.syncToken;
  postToUi(
    Object.assign(
      {
        type: "remote-fetch-start",
        provider: normalizedProvider,
        context
      },
      publicState()
    )
  );

  try {
    const result =
      normalizedProvider === "github"
        ? await fetchGitHubIconIndex(providerConfig)
        : await fetchAzureIconIndex(providerConfig);

    if (token !== runtime.syncToken) {
      return;
    }

    runtime.iconsByProvider[normalizedProvider] = result.icons;
    runtime.descriptorsByProvider[normalizedProvider] = result.descriptorsById;
    clearSvgCacheForProvider(normalizedProvider);

    if (result.normalizedConfig) {
      runtime.config.providers[normalizedProvider] = normalizeProviderConfig(
        normalizedProvider,
        Object.assign({}, runtime.config.providers[normalizedProvider], result.normalizedConfig, {
          connected: true
        })
      );
      await persistConfig();
    }

    postToUi(
      Object.assign(
        {
          type: "remote-fetch-success",
          provider: normalizedProvider,
          context
        },
        publicState()
      )
    );
  } catch (error) {
    if (token !== runtime.syncToken) {
      return;
    }

    postToUi(
      Object.assign(
        {
          type: "remote-fetch-failed",
          provider: normalizedProvider,
          context,
          error: getErrorMessage(error)
        },
        publicState()
      )
    );
  }
}

async function getSvgMarkup(iconId, descriptor) {
  if (runtime.svgCacheById.has(iconId)) {
    return runtime.svgCacheById.get(iconId);
  }

  const provider = normalizeProvider(descriptor.provider);
  if (!provider) {
    throw new Error("Unknown icon provider.");
  }

  const markup =
    provider === "github"
      ? await fetchGitHubSvgMarkup(descriptor)
      : await fetchAzureSvgMarkup(descriptor);

  const normalizedMarkup = normalizeSvgMarkup(markup);
  runtime.svgCacheById.set(iconId, normalizedMarkup);
  return normalizedMarkup;
}

async function fetchGitHubIconIndex(providerConfig) {
  const pat = normalizeString(providerConfig.pat);
  if (!pat) {
    throw new Error("GitHub PAT is required.");
  }

  const { owner, repo } = parseGitHubRepository(providerConfig.repository);
  const branch = normalizeString(providerConfig.branch) || "main";

  const treeUrl = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(
    repo
  )}/git/trees/${encodeURIComponent(branch)}?recursive=1`;

  const payload = await fetchJsonWithErrors(treeUrl, {
    headers: githubHeaders(pat)
  });

  if (payload && payload.truncated) {
    throw new Error(
      "GitHub tree response is truncated. Keep icon repo smaller or target a narrower branch."
    );
  }

  const tree = Array.isArray(payload && payload.tree) ? payload.tree : [];
  const metadataByKey = await tryLoadGitHubIconsMetadata(owner, repo, branch, pat);
  const allSvgFiles = tree.filter(
    (item) =>
      item &&
      item.type === "blob" &&
      typeof item.path === "string" &&
      isSvgPath(item.path)
  );
  const svgFiles = allSvgFiles.filter(
    (item) =>
      item &&
      item.type === "blob" &&
      typeof item.path === "string" &&
      isIconsFolderSvgPath(item.path)
  );
  const iconFiles = svgFiles.length ? svgFiles : allSvgFiles;

  if (!iconFiles.length) {
    throw new Error("No .svg files were found in the GitHub repository for the selected branch.");
  }

  const descriptorsById = new Map();
  const icons = iconFiles.map((item) => {
    const path = String(item.path);
    const fileName = iconNameFromPath(path);
    const metadata = findIconMetadata(fileName, metadataByKey);
    const title = metadata && metadata.title ? metadata.title : humanizeIconLabel(fileName);
    const name = metadata && metadata.name ? metadata.name : fileName;
    const tag = metadata && metadata.tag ? metadata.tag : "";
    const id = `github:${path}`;
    descriptorsById.set(id, {
      provider: "github",
      owner,
      repo,
      branch,
      path,
      sha: normalizeString(item.sha)
    });
    return {
      id,
      path,
      name,
      title,
      tag
    };
  });

  icons.sort((a, b) =>
    iconDisplayLabel(a).localeCompare(iconDisplayLabel(b), undefined, { sensitivity: "base" })
  );

  return {
    icons,
    descriptorsById,
    normalizedConfig: {
      repository: `${owner}/${repo}`,
      branch
    }
  };
}

async function fetchAzureIconIndex(providerConfig) {
  const pat = normalizeString(providerConfig.pat);
  if (!pat) {
    throw new Error("Azure PAT is required.");
  }

  const organization = parseAzureOrganization(providerConfig.organizationUrl);
  const branch = normalizeString(providerConfig.branch) || "main";
  const { project, repository } = resolveAzureProjectAndRepository(
    providerConfig.repository,
    providerConfig.project,
    organization
  );

  const endpoint = azureItemsEndpoint(organization, project, repository);
  const params = toQueryString({
    scopePath: "/",
    recursionLevel: "Full",
    includeContentMetadata: "true",
    "versionDescriptor.versionType": "branch",
    "versionDescriptor.version": branch,
    "api-version": "7.1"
  });

  const payload = await fetchJsonWithErrors(`${endpoint}?${params}`, {
    headers: azureHeaders(pat)
  });

  const items = Array.isArray(payload && payload.value) ? payload.value : [];
  const metadataByKey = await tryLoadAzureIconsMetadata(
    organization,
    project,
    repository,
    branch,
    pat
  );
  const allSvgFiles = items.filter(
    (item) =>
      item &&
      item.isFolder !== true &&
      typeof item.path === "string" &&
      isSvgPath(item.path)
  );
  const svgFiles = allSvgFiles.filter(
    (item) =>
      item &&
      item.isFolder !== true &&
      typeof item.path === "string" &&
      isIconsFolderSvgPath(item.path)
  );
  const iconFiles = svgFiles.length ? svgFiles : allSvgFiles;

  if (!iconFiles.length) {
    throw new Error(
      "No .svg files were found in the Azure DevOps repository for the selected branch."
    );
  }

  const descriptorsById = new Map();
  const icons = iconFiles.map((item) => {
    const path = String(item.path);
    const fileName = iconNameFromPath(path);
    const metadata = findIconMetadata(fileName, metadataByKey);
    const title = metadata && metadata.title ? metadata.title : humanizeIconLabel(fileName);
    const name = metadata && metadata.name ? metadata.name : fileName;
    const tag = metadata && metadata.tag ? metadata.tag : "";
    const id = `azure:${path}`;
    descriptorsById.set(id, {
      provider: "azure",
      organization,
      project,
      repository,
      branch,
      path
    });
    return {
      id,
      path,
      name,
      title,
      tag
    };
  });

  icons.sort((a, b) =>
    iconDisplayLabel(a).localeCompare(iconDisplayLabel(b), undefined, { sensitivity: "base" })
  );

  return {
    icons,
    descriptorsById,
    normalizedConfig: {
      organizationUrl: `https://dev.azure.com/${organization}`,
      project,
      repository,
      branch
    }
  };
}

async function fetchGitHubSvgMarkup(descriptor) {
  const pat = normalizeString(runtime.config.providers.github.pat);
  if (!pat) {
    throw new Error("GitHub PAT is required.");
  }

  if (descriptor.sha) {
    try {
      const blobUrl = `https://api.github.com/repos/${encodeURIComponent(
        descriptor.owner
      )}/${encodeURIComponent(descriptor.repo)}/git/blobs/${encodeURIComponent(descriptor.sha)}`;
      const blobPayload = await fetchJsonWithErrors(blobUrl, {
        headers: githubHeaders(pat)
      });

      if (blobPayload && typeof blobPayload.content === "string") {
        return decodeBase64(blobPayload.content);
      }
    } catch (error) {
      // Some PAT scopes can list tree entries but deny git/blob endpoint.
      // Fall through to the contents endpoint as a compatibility fallback.
    }
  }

  const path = String(descriptor.path).replace(/^\/+/, "");
  const contentsUrl = `https://api.github.com/repos/${encodeURIComponent(
    descriptor.owner
  )}/${encodeURIComponent(descriptor.repo)}/contents/${encodePath(path)}?ref=${encodeURIComponent(
    descriptor.branch || "main"
  )}`;

  const payload = await fetchJsonWithErrors(contentsUrl, {
    headers: githubHeaders(pat)
  });

  if (payload && typeof payload.content === "string") {
    return decodeBase64(payload.content);
  }

  throw new Error("GitHub returned an empty SVG payload.");
}

async function fetchAzureSvgMarkup(descriptor) {
  const pat = normalizeString(runtime.config.providers.azure.pat);
  if (!pat) {
    throw new Error("Azure PAT is required.");
  }

  return fetchAzureFileText(
    descriptor.organization,
    descriptor.project,
    descriptor.repository,
    descriptor.branch || "main",
    descriptor.path,
    pat
  );
}

async function tryLoadGitHubIconsMetadata(owner, repo, branch, pat) {
  const candidates = ["Icons.json", "icons.json", "Icons/Icons.json", "icons/icons.json"];
  for (let index = 0; index < candidates.length; index += 1) {
    const path = candidates[index];
    try {
      const text = await fetchGitHubFileText(owner, repo, branch, path, pat);
      return parseIconsMetadata(text);
    } catch (error) {
      continue;
    }
  }
  return new Map();
}

async function tryLoadAzureIconsMetadata(organization, project, repository, branch, pat) {
  const candidates = ["/Icons.json", "/icons.json", "/Icons/Icons.json", "/icons/icons.json"];
  for (let index = 0; index < candidates.length; index += 1) {
    const path = candidates[index];
    try {
      const text = await fetchAzureFileText(organization, project, repository, branch, path, pat);
      return parseIconsMetadata(text);
    } catch (error) {
      continue;
    }
  }
  return new Map();
}

async function fetchGitHubFileText(owner, repo, branch, filePath, pat) {
  const normalizedPath = String(filePath || "").replace(/^\/+/, "");
  const contentsUrl = `https://api.github.com/repos/${encodeURIComponent(
    owner
  )}/${encodeURIComponent(repo)}/contents/${encodePath(normalizedPath)}?ref=${encodeURIComponent(
    branch || "main"
  )}`;
  const payload = await fetchJsonWithErrors(contentsUrl, {
    headers: githubHeaders(pat)
  });

  if (payload && typeof payload.content === "string") {
    return decodeBase64(payload.content);
  }

  throw new Error(`GitHub returned an empty payload for ${normalizedPath}.`);
}

async function fetchAzureFileText(organization, project, repository, branch, filePath, pat) {
  const endpoint = azureItemsEndpoint(organization, project, repository);
  const params = toQueryString({
    path: String(filePath),
    includeContent: "true",
    "versionDescriptor.versionType": "branch",
    "versionDescriptor.version": branch || "main",
    "api-version": "7.1"
  });

  const response = await fetch(`${endpoint}?${params}`, {
    headers: azureHeaders(pat)
  });

  if (!response.ok) {
    throw new Error(await responseErrorMessage(response));
  }

  const body = await response.text();
  if (!body) {
    throw new Error(`Azure DevOps returned an empty payload for ${filePath}.`);
  }

  const trimmed = body.trim();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      const json = JSON.parse(trimmed);
      if (json && typeof json.content === "string") {
        return json.content;
      }
      if (json && typeof json.value === "string") {
        return json.value;
      }
      if (json && Array.isArray(json.value) && json.value[0] && typeof json.value[0].content === "string") {
        return json.value[0].content;
      }
    } catch (error) {
      return body;
    }
  }

  return body;
}

function parseIconsMetadata(jsonText) {
  const trimmed = normalizeString(removeBom(jsonText));
  if (!trimmed) {
    return new Map();
  }

  let payload;
  try {
    payload = JSON.parse(trimmed);
  } catch (error) {
    try {
      payload = JSON.parse(trimmed.replace(/,\s*([}\]])/g, "$1"));
    } catch (innerError) {
      throw new Error("Icons.json is not valid JSON.");
    }
  }

  const rows = extractMetadataRows(payload);

  const byKey = new Map();
  rows.forEach((row) => {
    if (!row || typeof row !== "object") {
      return;
    }

    const rawName = normalizeString(readRowValue(row, ["name", "iconName"]));
    const rawTitle = normalizeString(readRowValue(row, ["title", "displayName", "label"]));
    const rawTag = normalizeString(readRowValue(row, ["tag", "tags", "keyword"]));
    if (!rawName && !rawTitle) {
      return;
    }

    const metadata = {
      name: rawName || rawTitle || "Icon",
      title: rawTitle || rawName || "Icon",
      tag: rawTag
    };

    addMetadataRecord(byKey, rawName, metadata);
    addMetadataRecord(byKey, rawTitle, metadata);
  });

  return byKey;
}

function addMetadataRecord(store, value, metadata) {
  const keys = iconLookupKeyVariants(value);
  keys.forEach((key) => {
    if (!store.has(key)) {
      store.set(key, metadata);
    }
  });
}

function findIconMetadata(iconName, metadataByKey) {
  if (!metadataByKey || typeof metadataByKey.get !== "function") {
    return null;
  }

  const keys = iconLookupKeyVariants(iconName);
  for (let index = 0; index < keys.length; index += 1) {
    const key = keys[index];
    if (metadataByKey.has(key)) {
      return metadataByKey.get(key);
    }
  }
  return null;
}

function isIconsFolderSvgPath(path) {
  const normalized = String(path || "")
    .replace(/\\/g, "/")
    .replace(/^\/+/, "");
  const lowercase = normalized.toLowerCase();
  if (!lowercase.endsWith(".svg")) {
    return false;
  }
  const segments = lowercase.split("/").filter(Boolean);
  return segments.includes("icons");
}

function isSvgPath(path) {
  const normalized = String(path || "")
    .replace(/\\/g, "/")
    .replace(/^\/+/, "");
  return normalized.toLowerCase().endsWith(".svg");
}

function iconLookupKeyVariants(value) {
  const raw = normalizeString(value).replace(/\.svg$/i, "");
  if (!raw) {
    return [];
  }

  const variants = [
    normalizeLookupKey(raw),
    normalizeLookupKey(stripIconPrefix(raw)),
    normalizeLookupKey(stripStyleSuffix(raw)),
    normalizeLookupKey(stripStyleSuffix(stripIconPrefix(raw)))
  ];

  const unique = [];
  const seen = new Set();
  variants.forEach((item) => {
    if (!item || seen.has(item)) {
      return;
    }
    seen.add(item);
    unique.push(item);
  });
  return unique;
}

function normalizeLookupKey(value) {
  const raw = normalizeString(value).replace(/\.svg$/i, "").toLowerCase();
  if (!raw) {
    return "";
  }
  return raw.replace(/[^a-z0-9]+/g, "");
}

function iconDisplayLabel(icon) {
  return normalizeString(icon && icon.title) || normalizeString(icon && icon.name) || "Icon";
}

function extractMetadataRows(payload) {
  if (Array.isArray(payload)) {
    return payload;
  }

  if (!payload || typeof payload !== "object") {
    return [];
  }

  const priorityKeys = ["icons", "value", "items", "data", "Icon", "Icons"];
  for (let index = 0; index < priorityKeys.length; index += 1) {
    const key = priorityKeys[index];
    if (Array.isArray(payload[key])) {
      return payload[key];
    }
  }

  const keys = Object.keys(payload);
  for (let index = 0; index < keys.length; index += 1) {
    const key = keys[index];
    const value = payload[key];
    if (Array.isArray(value) && value.length && typeof value[0] === "object") {
      return value;
    }
  }

  return [];
}

function readRowValue(row, keys) {
  if (!row || typeof row !== "object") {
    return "";
  }

  for (let index = 0; index < keys.length; index += 1) {
    const target = keys[index].toLowerCase();
    const rowKeys = Object.keys(row);
    for (let keyIndex = 0; keyIndex < rowKeys.length; keyIndex += 1) {
      const rowKey = rowKeys[keyIndex];
      if (rowKey.toLowerCase() !== target) {
        continue;
      }
      return row[rowKey];
    }
  }

  return "";
}

function removeBom(value) {
  return String(value || "").replace(/^\uFEFF/, "");
}

function humanizeIconLabel(value) {
  const raw = normalizeString(value).replace(/\.svg$/i, "");
  if (!raw) {
    return "Icon";
  }

  const withoutPrefix = stripIconPrefix(raw);
  const withoutSuffix = stripStyleSuffix(withoutPrefix);
  const spaced = withoutSuffix
    .replace(/[_-]+/g, " ")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/\s+/g, " ")
    .trim();

  return spaced || raw;
}

function stripIconPrefix(value) {
  return normalizeString(value).replace(/^icon(?=[A-Z0-9_ -])/i, "");
}

function stripStyleSuffix(value) {
  return normalizeString(value).replace(
    /(?:[_\-\s]?)(outline|fill|bulk|outlined|filled)$/i,
    ""
  );
}

function normalizeVariantLabel(value) {
  const raw = normalizeString(value).toLowerCase();
  if (!raw) {
    return "";
  }

  if (raw === "outline" || raw === "outlined") {
    return "outline";
  }
  if (raw === "fill" || raw === "filled") {
    return "fill";
  }
  if (raw === "bulk") {
    return "bulk";
  }

  return "";
}

function extractIconBaseAndVariant(rawName) {
  const source = normalizeString(rawName).replace(/\.svg$/i, "");
  if (!source) {
    return {
      baseName: "Icon",
      variant: ""
    };
  }

  const variantMatch = source.match(/(?:[_\-\s]?)(outline|fill|bulk|outlined|filled)$/i);
  if (!variantMatch || variantMatch.index === undefined) {
    return {
      baseName: source,
      variant: ""
    };
  }

  const baseName = source.slice(0, variantMatch.index).replace(/[_\-\s]+$/, "") || source;
  return {
    baseName,
    variant: normalizeVariantLabel(variantMatch[1])
  };
}

function toKebabCase(value) {
  const withoutPrefix = normalizeString(value)
    .replace(/^icon[-_\s]+/i, "")
    .replace(/^icon(?=[A-Z0-9_ -])/i, "");

  const kebab = withoutPrefix
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .replace(/[^a-zA-Z0-9]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase();

  return kebab || "icon";
}

function formatIconName(baseName, variant) {
  const normalizedBase = toKebabCase(baseName);
  const normalizedVariant = normalizeVariantLabel(variant) || "outline";
  return `${normalizedBase}-${normalizedVariant}`;
}

function azureItemsEndpoint(organization, project, repository) {
  return `https://dev.azure.com/${encodeURIComponent(organization)}/${encodeURIComponent(
    project
  )}/_apis/git/repositories/${encodeURIComponent(repository)}/items`;
}

function githubHeaders(pat) {
  return {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${pat}`,
    "X-GitHub-Api-Version": "2022-11-28"
  };
}

function azureHeaders(pat) {
  return {
    Accept: "application/json",
    Authorization: `Basic ${toBase64(`:${pat}`)}`
  };
}

function toQueryString(values) {
  if (!values || typeof values !== "object") {
    return "";
  }

  return Object.entries(values)
    .filter(([, value]) => value !== undefined && value !== null)
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`)
    .join("&");
}

function decodeUriComponentSafe(value) {
  const input = String(value == null ? "" : value);
  try {
    return decodeURIComponent(input);
  } catch (error) {
    return input;
  }
}

function parseHttpLikeUrl(value) {
  const raw = normalizeString(value);
  if (!raw) {
    return null;
  }

  const normalized = raw.includes("://") ? raw : `https://${raw}`;
  const nativeUrl = typeof URL === "function" ? URL : null;
  if (nativeUrl) {
    try {
      const parsed = new nativeUrl(normalized);
      return {
        hostname: String(parsed.hostname || "").toLowerCase(),
        pathParts: String(parsed.pathname || "")
          .split("/")
          .filter(Boolean)
          .map((part) => decodeUriComponentSafe(part))
      };
    } catch (error) {
      // Fall through to regex parser.
    }
  }

  const match = normalized.match(/^https?:\/\/([^\/?#]+)(\/[^?#]*)?/i);
  if (!match) {
    return null;
  }

  return {
    hostname: String(match[1] || "").toLowerCase(),
    pathParts: String(match[2] || "")
      .split("/")
      .filter(Boolean)
      .map((part) => decodeUriComponentSafe(part))
  };
}

function parseGitHubRepository(value) {
  const raw = normalizeString(value);
  if (!raw) {
    throw new Error("Repository is required. Use owner/repo.");
  }

  if (/^https?:\/\//i.test(raw)) {
    const parsedUrl = parseHttpLikeUrl(raw);
    if (!parsedUrl) {
      throw new Error("Use a valid GitHub repository URL.");
    }
    if (!/github\.com$/i.test(parsedUrl.hostname)) {
      throw new Error("GitHub repository URL must use github.com.");
    }
    const parts = parsedUrl.pathParts;
    if (parts.length < 2) {
      throw new Error("Repository URL must include owner and repo.");
    }
    return {
      owner: parts[0],
      repo: parts[1].replace(/\.git$/i, "")
    };
  }

  const parts = raw.split("/").filter(Boolean);
  if (parts.length < 2) {
    throw new Error("Repository must be in owner/repo format.");
  }

  return {
    owner: parts[0],
    repo: parts[1].replace(/\.git$/i, "")
  };
}

function parseAzureOrganization(organizationUrl) {
  const raw = normalizeString(organizationUrl);
  if (!raw) {
    throw new Error("Organization URL is required.");
  }

  if (!raw.includes("/") && !raw.includes(".")) {
    return raw;
  }

  const parsedUrl = parseHttpLikeUrl(raw);
  if (!parsedUrl) {
    throw new Error("Use a valid Azure URL: https://dev.azure.com/{organization}");
  }
  const host = parsedUrl.hostname;

  if (host === "dev.azure.com") {
    const parts = parsedUrl.pathParts;
    if (!parts.length) {
      throw new Error("Organization URL must include organization name.");
    }
    return parts[0];
  }

  const match = host.match(/^([^.]+)\.visualstudio\.com$/i);
  if (match && match[1]) {
    return match[1];
  }

  throw new Error("Use a valid Azure URL: https://dev.azure.com/{organization}");
}

function resolveAzureProjectAndRepository(repositoryValue, projectValue, organization) {
  let repository = normalizeString(repositoryValue);
  let project = normalizeString(projectValue);

  if (!repository) {
    throw new Error(
      "Repository is required. Use a repository name or project/_git/repository."
    );
  }

  if (/^https?:\/\//i.test(repository)) {
    const parsedUrl = parseHttpLikeUrl(repository);
    if (!parsedUrl) {
      throw new Error(
        "Repository is required. Use a repository name or project/_git/repository."
      );
    }
    const parts = parsedUrl.pathParts;
    let trimmedParts = parts;

    if (parsedUrl.hostname === "dev.azure.com" && parts[0]) {
      trimmedParts = parts[0].toLowerCase() === organization.toLowerCase() ? parts.slice(1) : parts;
    }

    const gitIndex = trimmedParts.indexOf("_git");
    if (gitIndex >= 0) {
      if (!project && gitIndex > 0) {
        project = trimmedParts[gitIndex - 1];
      }
      repository = trimmedParts[gitIndex + 1] || "";
    } else if (trimmedParts.length >= 2) {
      if (!project) {
        project = trimmedParts[0];
      }
      repository = trimmedParts[1];
    }
  }

  if (repository.includes("/_git/")) {
    const [left, right] = repository.split("/_git/");
    const leftParts = left.split("/").filter(Boolean);
    const rightParts = right.split("/").filter(Boolean);
    if (!project && leftParts.length) {
      const candidate = leftParts[leftParts.length - 1];
      project = candidate.toLowerCase() === organization.toLowerCase() && leftParts.length > 1
        ? leftParts[leftParts.length - 2]
        : candidate;
    }
    repository = rightParts[0] || repository;
  } else if (repository.includes("/")) {
    const parts = repository.split("/").filter(Boolean);
    if (parts.length >= 2) {
      if (
        !project &&
        parts.length === 2 &&
        parts[0].toLowerCase() === String(organization || "").toLowerCase()
      ) {
        throw new Error(
          "Project is required for Azure DevOps. Fill Project or use repository format project/_git/repository."
        );
      }
      if (!project) {
        project = parts[0];
      }
      repository = parts[parts.length - 1];
    }
  }

  repository = repository.replace(/\.git$/i, "");

  if (!project) {
    throw new Error(
      "Project is required for Azure DevOps. Fill Project or use repository format project/_git/repository."
    );
  }
  if (!repository) {
    throw new Error("Repository is required for Azure DevOps.");
  }

  return { project, repository };
}

function normalizeSvgMarkup(markup) {
  const value = normalizeString(markup);
  if (!value || !/<svg[\s>]/i.test(value)) {
    throw new Error("Fetched file is not a valid SVG.");
  }
  return value;
}

function withSvgSize(markup, targetSize) {
  const size = Number(targetSize);
  if (!Number.isFinite(size) || size <= 0) {
    return markup;
  }

  const nextSize = String(Math.round(size));
  return String(markup).replace(/<svg\b([^>]*)>/i, (full, attrs) => {
    let nextAttrs = String(attrs || "");

    if (/\bwidth\s*=\s*(['"]).*?\1/i.test(nextAttrs)) {
      nextAttrs = nextAttrs.replace(/\bwidth\s*=\s*(['"]).*?\1/i, `width="${nextSize}"`);
    } else {
      nextAttrs += ` width="${nextSize}"`;
    }

    if (/\bheight\s*=\s*(['"]).*?\1/i.test(nextAttrs)) {
      nextAttrs = nextAttrs.replace(/\bheight\s*=\s*(['"]).*?\1/i, `height="${nextSize}"`);
    } else {
      nextAttrs += ` height="${nextSize}"`;
    }

    return `<svg${nextAttrs}>`;
  });
}

function decodeBase64(value) {
  const normalized = String(value || "").replace(/\s+/g, "");
  if (typeof Buffer !== "undefined") {
    return Buffer.from(normalized, "base64").toString("utf8");
  }

  if (typeof atob === "function") {
    const binary = atob(normalized);
    const bytes = new Uint8Array(binary.length);

    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
    return decodeUtf8Bytes(bytes);
  }

  const bytes = decodeBase64ToBytes(normalized);
  return decodeUtf8Bytes(bytes);
}

async function fetchJsonWithErrors(url, options) {
  const response = await fetch(url, options);
  const text = await response.text();
  let payload = null;

  if (text) {
    try {
      payload = JSON.parse(text);
    } catch (error) {
      payload = null;
    }
  }

  if (!response.ok) {
    throw new Error(buildErrorMessage(response, payload, text));
  }

  if (payload === null) {
    throw new Error("Unexpected empty response.");
  }

  return payload;
}

async function responseErrorMessage(response) {
  const text = await response.text();
  let payload = null;

  if (text) {
    try {
      payload = JSON.parse(text);
    } catch (error) {
      payload = null;
    }
  }

  return buildErrorMessage(response, payload, text);
}

function buildErrorMessage(response, payload, rawText) {
  const suffix =
    extractPayloadMessage(payload) || normalizeString(rawText) || `${response.status} ${response.statusText}`;
  return `${response.status} ${response.statusText}: ${suffix}`.trim();
}

function extractPayloadMessage(payload) {
  if (!payload || typeof payload !== "object") {
    return "";
  }
  if (typeof payload.message === "string") {
    return payload.message;
  }
  if (payload.error && typeof payload.error.message === "string") {
    return payload.error.message;
  }
  if (Array.isArray(payload.errors) && payload.errors[0] && typeof payload.errors[0].message === "string") {
    return payload.errors[0].message;
  }
  return "";
}

function iconNameFromPath(path) {
  const fileName = String(path || "").split("/").pop() || "Icon";
  return fileName.replace(/\.svg$/i, "") || "Icon";
}

function encodePath(path) {
  return String(path || "")
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
}

function clearSvgCacheForProvider(provider) {
  const prefix = `${provider}:`;
  for (const key of Array.from(runtime.svgCacheById.keys())) {
    if (key.startsWith(prefix)) {
      runtime.svgCacheById.delete(key);
    }
  }
}

function postHydration() {
  postToUi(
    Object.assign(
      {
        type: "state-hydrate"
      },
      publicState()
    )
  );
}

function publicState() {
  const selected = ensureSelectedProvider();
  const icons = selected ? runtime.iconsByProvider[selected] || [] : [];
  return {
    selectedProvider: selected,
    providers: clone(runtime.config.providers),
    icons
  };
}

function postToUi(message) {
  figma.ui.postMessage(message);
}

function getDescriptorByIconId(iconId) {
  const provider = normalizeProvider(normalizeString(iconId).split(":")[0]);
  if (!provider) {
    return null;
  }
  return runtime.descriptorsByProvider[provider].get(iconId) || null;
}

function resolveNodeIconDetails(node) {
  if (!node || typeof node.getPluginData !== "function") {
    return null;
  }

  const managed = node.getPluginData(NODE_META_KEY_MANAGED) === "1";
  let provider = normalizeProvider(node.getPluginData(NODE_META_KEY_PROVIDER));
  if (!provider) {
    provider = ensureSelectedProvider();
  }
  if (!provider) {
    return null;
  }

  const descriptors = runtime.descriptorsByProvider[provider];
  let iconId = normalizeString(node.getPluginData(NODE_META_KEY_ICON_ID));
  let descriptor = iconId ? descriptors.get(iconId) || null : null;

  if (!descriptor) {
    const path = normalizeString(node.getPluginData(NODE_META_KEY_PATH));
    if (path) {
      iconId = `${provider}:${path}`;
      descriptor = descriptors.get(iconId) || null;
    }
  }

  if (!descriptor && !managed) {
    const byName = findDescriptorByFormattedName(provider, node.name);
    if (byName) {
      return byName;
    }
    return null;
  }

  if (!descriptor) {
    return null;
  }

  const details = descriptorDetailsFromEntry(provider, iconId, descriptor);
  const storedBaseName = normalizeString(node.getPluginData(NODE_META_KEY_BASE_NAME));
  const storedVariant = normalizeVariantLabel(node.getPluginData(NODE_META_KEY_VARIANT));
  const storedSize = parseSizeValue(node.getPluginData(NODE_META_KEY_SIZE));

  if (storedBaseName) {
    details.baseName = storedBaseName;
    details.baseKey = normalizeLookupKey(storedBaseName);
  }
  if (storedVariant) {
    details.variant = storedVariant;
  }
  details.size = storedSize || 0;
  return details;
}

function descriptorDetailsFromEntry(provider, iconId, descriptor) {
  const fileName = iconNameFromPath(descriptor.path);
  const parsed = extractIconBaseAndVariant(fileName);
  const baseName = parsed.baseName || fileName || "Icon";
  const variant = parsed.variant || "outline";

  return {
    provider,
    iconId,
    descriptor,
    path: descriptor.path,
    baseName,
    baseKey: normalizeLookupKey(baseName),
    variant,
    size: 0
  };
}

function findDescriptorByBaseAndVariant(provider, baseName, variant) {
  const normalizedProvider = normalizeProvider(provider);
  const normalizedVariant = normalizeVariantLabel(variant) || "outline";
  if (!normalizedProvider) {
    return null;
  }

  const targetBaseKey = normalizeLookupKey(baseName);
  const descriptors = runtime.descriptorsByProvider[normalizedProvider];
  let fallback = null;

  for (const [iconId, descriptor] of descriptors.entries()) {
    const details = descriptorDetailsFromEntry(normalizedProvider, iconId, descriptor);
    if (details.baseKey !== targetBaseKey) {
      continue;
    }
    if (details.variant === normalizedVariant) {
      return details;
    }
    if (!fallback && normalizedVariant === "outline" && details.variant === "outline") {
      fallback = details;
    }
  }

  return fallback;
}

function findDescriptorByFormattedName(provider, nodeName) {
  const normalizedProvider = normalizeProvider(provider);
  if (!normalizedProvider) {
    return null;
  }

  const normalizedNodeName = normalizeString(nodeName).toLowerCase();
  if (!normalizedNodeName) {
    return null;
  }

  const descriptors = runtime.descriptorsByProvider[normalizedProvider];
  const icons = runtime.iconsByProvider[normalizedProvider] || [];

  const titleById = new Map();
  for (let index = 0; index < icons.length; index += 1) {
    const icon = icons[index];
    if (!icon || !icon.id) {
      continue;
    }
    titleById.set(icon.id, normalizeString(icon.title).toLowerCase());
  }

  for (const [iconId, descriptor] of descriptors.entries()) {
    const details = descriptorDetailsFromEntry(normalizedProvider, iconId, descriptor);
    const formatted = formatIconName(details.baseName, details.variant).toLowerCase();
    if (formatted === normalizedNodeName) {
      return details;
    }
    const title = titleById.get(iconId);
    if (title && title === normalizedNodeName) {
      return details;
    }
  }

  return null;
}

function setIconNodeMetadata(node, values) {
  if (!node || typeof node.setPluginData !== "function") {
    return;
  }

  node.setPluginData(NODE_META_KEY_MANAGED, "1");
  node.setPluginData(NODE_META_KEY_PROVIDER, normalizeProvider(values.provider) || "");
  node.setPluginData(NODE_META_KEY_ICON_ID, normalizeString(values.iconId));
  node.setPluginData(NODE_META_KEY_PATH, normalizeString(values.path));
  node.setPluginData(NODE_META_KEY_BASE_NAME, normalizeString(values.baseName));
  node.setPluginData(NODE_META_KEY_VARIANT, normalizeVariantLabel(values.variant) || "outline");
  node.setPluginData(
    NODE_META_KEY_SIZE,
    values.size && Number.isFinite(Number(values.size)) ? String(Math.round(Number(values.size))) : ""
  );
}

function parseSizeValue(value) {
  const numeric = Number(normalizeString(value));
  if (!Number.isFinite(numeric) || numeric <= 0) {
    return 0;
  }
  return Math.round(numeric);
}

function nodeNominalSize(node) {
  if (!node) {
    return 0;
  }

  const width = Number(node.width);
  const height = Number(node.height);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return 0;
  }

  return Math.round(Math.max(width, height));
}

function trySetNodePositionByCenter(node, centerX, centerY) {
  if (!node) {
    return;
  }
  try {
    node.x = centerX - node.width / 2;
    node.y = centerY - node.height / 2;
  } catch (error) {
    // Parent may enforce auto-layout positioning.
  }
}

function copyNodeVisualState(fromNode, toNode) {
  if (!fromNode || !toNode) {
    return;
  }

  const copyIfPresent = (key) => {
    if (!(key in fromNode) || !(key in toNode)) {
      return;
    }
    try {
      toNode[key] = fromNode[key];
    } catch (error) {
      // Ignore non-assignable properties.
    }
  };

  ["visible", "locked", "opacity", "blendMode", "rotation", "layoutAlign", "layoutGrow", "layoutPositioning"].forEach(
    copyIfPresent
  );

  if ("constraints" in fromNode && "constraints" in toNode) {
    try {
      toNode.constraints = fromNode.constraints;
    } catch (error) {
      // Ignore when unsupported.
    }
  }
}

function applyNodeTint(rootNode, color) {
  if (!rootNode || !color) {
    return;
  }

  const tintPaints = (paints) => {
    if (!Array.isArray(paints) || paints === figma.mixed) {
      return paints;
    }

    return paints.map((paint) => {
      if (!paint || paint.type !== "SOLID") {
        return paint;
      }
      return Object.assign({}, paint, {
        color: {
          r: color.r,
          g: color.g,
          b: color.b
        }
      });
    });
  };

  const walk = (node) => {
    if (!node) {
      return;
    }

    if ("fills" in node) {
      try {
        node.fills = tintPaints(node.fills);
      } catch (error) {
        // Ignore nodes with non-assignable fills.
      }
    }

    if ("strokes" in node) {
      try {
        node.strokes = tintPaints(node.strokes);
      } catch (error) {
        // Ignore nodes with non-assignable strokes.
      }
    }

    if ("children" in node && Array.isArray(node.children)) {
      for (let index = 0; index < node.children.length; index += 1) {
        walk(node.children[index]);
      }
    }
  };

  walk(rootNode);
}

function ensureSelectedProvider() {
  const selected = normalizeProvider(runtime.config.selectedProvider);
  if (selected && runtime.config.providers[selected].connected) {
    runtime.config.selectedProvider = selected;
    return selected;
  }

  const firstConnected = getFirstConnectedProvider();
  runtime.config.selectedProvider = firstConnected;
  return firstConnected;
}

function getFirstConnectedProvider() {
  if (runtime.config.providers.azure.connected) {
    return "azure";
  }
  if (runtime.config.providers.github.connected) {
    return "github";
  }
  return null;
}

async function loadStoredConfig() {
  const stored = await figma.clientStorage.getAsync(STORAGE_KEY);
  runtime.config = normalizeConfig(stored);
  ensureSelectedProvider();
}

async function persistConfig() {
  await figma.clientStorage.setAsync(STORAGE_KEY, clone(runtime.config));
}

function normalizeConfig(rawConfig) {
  const source = rawConfig && typeof rawConfig === "object" ? rawConfig : {};
  const providers = source.providers && typeof source.providers === "object" ? source.providers : {};
  const selectedProvider = normalizeProvider(source.selectedProvider);

  const normalized = {
    selectedProvider,
    providers: {
      azure: normalizeProviderConfig("azure", providers.azure),
      github: normalizeProviderConfig("github", providers.github)
    }
  };

  if (normalized.selectedProvider && !normalized.providers[normalized.selectedProvider].connected) {
    normalized.selectedProvider = null;
  }

  return normalized;
}

function normalizeProviderConfig(provider, rawConfig) {
  const source = rawConfig && typeof rawConfig === "object" ? rawConfig : {};

  if (provider === "azure") {
    return {
      connected: Boolean(source.connected),
      organizationUrl: normalizeString(source.organizationUrl),
      project: normalizeString(source.project),
      pat: normalizeString(source.pat),
      repository: normalizeString(source.repository),
      branch: normalizeString(source.branch) || "main"
    };
  }

  return {
    connected: Boolean(source.connected),
    pat: normalizeString(source.pat),
    repository: normalizeString(source.repository),
    branch: normalizeString(source.branch) || "main"
  };
}

function normalizeProvider(value) {
  if (value === "azure" || value === "github") {
    return value;
  }
  return null;
}

function normalizeString(value) {
  if (typeof value === "string") {
    return value.trim();
  }
  if (value === null || value === undefined) {
    return "";
  }
  return String(value).trim();
}

function resizeNodeToTarget(node, targetSize) {
  if (!node || typeof targetSize !== "number" || targetSize <= 0) {
    return;
  }

  const width = Number(node.width);
  const height = Number(node.height);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return;
  }

  const source = Math.max(width, height);
  const scale = targetSize / source;
  if (!Number.isFinite(scale) || scale <= 0 || Math.abs(scale - 1) < 0.0001) {
    return;
  }

  if (typeof node.rescale === "function") {
    try {
      node.rescale(scale);
      return;
    } catch (error) {
      // Fall through to width/height based resize.
    }
  }

  const nextWidth = Math.max(1, width * scale);
  const nextHeight = Math.max(1, height * scale);

  if (typeof node.resizeWithoutConstraints === "function") {
    node.resizeWithoutConstraints(nextWidth, nextHeight);
    return;
  }

  if (typeof node.resize === "function") {
    node.resize(nextWidth, nextHeight);
  }
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function getErrorMessage(error) {
  if (error instanceof Error && error.message) {
    return error.message;
  }
  if (typeof error === "string") {
    return error;
  }
  return "Unexpected error";
}

function toBase64(value) {
  const text = String(value || "");
  if (typeof Buffer !== "undefined") {
    return Buffer.from(text, "utf8").toString("base64");
  }
  if (typeof TextEncoder !== "undefined") {
    return bytesToBase64(new TextEncoder().encode(text));
  }
  if (typeof btoa === "function") {
    return btoa(text);
  }
  return encodeBase64FromBytes(encodeUtf8ToBytes(text));
}

function decodeUtf8Bytes(bytes) {
  if (typeof TextDecoder !== "undefined") {
    return new TextDecoder("utf-8").decode(bytes);
  }

  let raw = "";
  for (let index = 0; index < bytes.length; index += 1) {
    raw += String.fromCharCode(bytes[index]);
  }
  return decodeURIComponent(escape(raw));
}

function bytesToBase64(bytes) {
  if (typeof Buffer !== "undefined") {
    return Buffer.from(bytes).toString("base64");
  }
  if (typeof btoa === "function") {
    let binary = "";
    for (let index = 0; index < bytes.length; index += 1) {
      binary += String.fromCharCode(bytes[index]);
    }
    return btoa(binary);
  }
  return encodeBase64FromBytes(bytes);
}

function encodeUtf8ToBytes(value) {
  const text = String(value == null ? "" : value);
  const out = [];

  for (let index = 0; index < text.length; index += 1) {
    let codePoint = text.charCodeAt(index);

    if (
      codePoint >= 0xd800 &&
      codePoint <= 0xdbff &&
      index + 1 < text.length
    ) {
      const low = text.charCodeAt(index + 1);
      if (low >= 0xdc00 && low <= 0xdfff) {
        codePoint = ((codePoint - 0xd800) << 10) + (low - 0xdc00) + 0x10000;
        index += 1;
      }
    }

    if (codePoint <= 0x7f) {
      out.push(codePoint);
      continue;
    }
    if (codePoint <= 0x7ff) {
      out.push(0xc0 | (codePoint >> 6), 0x80 | (codePoint & 0x3f));
      continue;
    }
    if (codePoint <= 0xffff) {
      out.push(
        0xe0 | (codePoint >> 12),
        0x80 | ((codePoint >> 6) & 0x3f),
        0x80 | (codePoint & 0x3f)
      );
      continue;
    }
    out.push(
      0xf0 | (codePoint >> 18),
      0x80 | ((codePoint >> 12) & 0x3f),
      0x80 | ((codePoint >> 6) & 0x3f),
      0x80 | (codePoint & 0x3f)
    );
  }

  return new Uint8Array(out);
}

function decodeBase64ToBytes(value) {
  const normalized = String(value || "").replace(/[^A-Za-z0-9+/=]/g, "");
  const bytes = [];
  let buffer = 0;
  let bits = 0;

  for (let index = 0; index < normalized.length; index += 1) {
    const char = normalized[index];
    if (char === "=") {
      break;
    }
    const code = BASE64_ALPHABET.indexOf(char);
    if (code < 0) {
      continue;
    }
    buffer = (buffer << 6) | code;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((buffer >> bits) & 0xff);
    }
  }

  return new Uint8Array(bytes);
}

function encodeBase64FromBytes(bytes) {
  let output = "";

  for (let index = 0; index < bytes.length; index += 3) {
    const byte1 = bytes[index];
    const byte2 = index + 1 < bytes.length ? bytes[index + 1] : 0;
    const byte3 = index + 2 < bytes.length ? bytes[index + 2] : 0;

    const chunk = (byte1 << 16) | (byte2 << 8) | byte3;
    output += BASE64_ALPHABET[(chunk >> 18) & 63];
    output += BASE64_ALPHABET[(chunk >> 12) & 63];
    output += index + 1 < bytes.length ? BASE64_ALPHABET[(chunk >> 6) & 63] : "=";
    output += index + 2 < bytes.length ? BASE64_ALPHABET[chunk & 63] : "=";
  }

  return output;
}

const BASE64_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
