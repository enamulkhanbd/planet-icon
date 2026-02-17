const UI_WIDTH = 380;
const UI_HEIGHT = 664;
const STORAGE_KEY = "planet-icon-config-v1";

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
    const node = figma.createNodeFromSvg(svg);
    const iconName =
      normalizeString(message.title) ||
      normalizeString(message.name) ||
      iconNameFromPath(descriptor.path);

    node.name = iconName;
    const center = figma.viewport.center;
    node.x = center.x - node.width / 2;
    node.y = center.y - node.height / 2;

    if (node.parent !== figma.currentPage) {
      figma.currentPage.appendChild(node);
    }

    figma.currentPage.selection = [node];
    figma.viewport.scrollAndZoomIntoView([node]);
    figma.notify(`Inserted ${iconName}`);
  } catch (error) {
    figma.notify(`Failed to insert icon: ${getErrorMessage(error)}`);
  }
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
  const svgFiles = tree.filter(
    (item) =>
      item &&
      item.type === "blob" &&
      typeof item.path === "string" &&
      isIconsFolderSvgPath(item.path)
  );

  if (!svgFiles.length) {
    throw new Error("No .svg files were found in the GitHub repository under Icons/.");
  }

  const descriptorsById = new Map();
  const icons = svgFiles.map((item) => {
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
  const params = new URLSearchParams();
  params.set("scopePath", "/");
  params.set("recursionLevel", "Full");
  params.set("includeContentMetadata", "true");
  params.set("versionDescriptor.versionType", "branch");
  params.set("versionDescriptor.version", branch);
  params.set("api-version", "7.1");

  const payload = await fetchJsonWithErrors(`${endpoint}?${params.toString()}`, {
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
  const svgFiles = items.filter(
    (item) =>
      item &&
      item.isFolder !== true &&
      typeof item.path === "string" &&
      isIconsFolderSvgPath(item.path)
  );

  if (!svgFiles.length) {
    throw new Error("No .svg files were found in the Azure DevOps repository under Icons/.");
  }

  const descriptorsById = new Map();
  const icons = svgFiles.map((item) => {
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
    const blobUrl = `https://api.github.com/repos/${encodeURIComponent(
      descriptor.owner
    )}/${encodeURIComponent(descriptor.repo)}/git/blobs/${encodeURIComponent(descriptor.sha)}`;
    const blobPayload = await fetchJsonWithErrors(blobUrl, {
      headers: githubHeaders(pat)
    });

    if (blobPayload && typeof blobPayload.content === "string") {
      return decodeBase64(blobPayload.content);
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
  const params = new URLSearchParams();
  params.set("path", String(filePath));
  params.set("includeContent", "true");
  params.set("versionDescriptor.versionType", "branch");
  params.set("versionDescriptor.version", branch || "main");
  params.set("api-version", "7.1");

  const response = await fetch(`${endpoint}?${params.toString()}`, {
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
  return lowercase.startsWith("icons/") && lowercase.endsWith(".svg");
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
  return normalizeString(value).replace(/(?:[_\-\s]?)(outline|fill|outlined|filled)$/i, "");
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

function parseGitHubRepository(value) {
  const raw = normalizeString(value);
  if (!raw) {
    throw new Error("Repository is required. Use owner/repo.");
  }

  if (/^https?:\/\//i.test(raw)) {
    const url = new URL(raw);
    if (!/github\.com$/i.test(url.hostname)) {
      throw new Error("GitHub repository URL must use github.com.");
    }
    const parts = url.pathname.split("/").filter(Boolean);
    if (parts.length < 2) {
      throw new Error("Repository URL must include owner and repo.");
    }
    return {
      owner: decodeURIComponent(parts[0]),
      repo: decodeURIComponent(parts[1]).replace(/\.git$/i, "")
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

  const normalizedUrl = raw.includes("://") ? raw : `https://${raw}`;
  const url = new URL(normalizedUrl);
  const host = url.hostname.toLowerCase();

  if (host === "dev.azure.com") {
    const parts = url.pathname.split("/").filter(Boolean);
    if (!parts.length) {
      throw new Error("Organization URL must include organization name.");
    }
    return decodeURIComponent(parts[0]);
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
    throw new Error("Repository is required.");
  }

  if (/^https?:\/\//i.test(repository)) {
    const url = new URL(repository);
    const parts = url.pathname.split("/").filter(Boolean).map((part) => decodeURIComponent(part));
    let trimmedParts = parts;

    if (url.hostname.toLowerCase() === "dev.azure.com" && parts[0]) {
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
      if (!project) {
        project = parts[0];
      }
      repository = parts[parts.length - 1];
    }
  }

  repository = repository.replace(/\.git$/i, "");

  if (!project) {
    throw new Error("Project is required for Azure DevOps.");
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

function decodeBase64(value) {
  const normalized = String(value || "").replace(/\s+/g, "");
  const binary = atob(normalized);
  const bytes = new Uint8Array(binary.length);

  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }

  if (typeof TextDecoder !== "undefined") {
    return new TextDecoder("utf-8").decode(bytes);
  }

  let raw = "";
  for (let index = 0; index < bytes.length; index += 1) {
    raw += String.fromCharCode(bytes[index]);
  }
  return decodeURIComponent(escape(raw));
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
  if (typeof btoa === "function") {
    return btoa(value);
  }
  if (typeof Buffer !== "undefined") {
    return Buffer.from(value, "utf8").toString("base64");
  }
  throw new Error("Unable to encode authentication header.");
}
