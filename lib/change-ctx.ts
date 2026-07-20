/**
 * @lemonade/lemonade-provider
 *
 * Change context size for a loaded model: unload → reload with new ctx_size.
 */

/**
 * Change the context_size (ctx_size) for a loaded model via the Lemonade API.
 * Unloads the model, reloads it with new ctx_size and save_options: true.
 * Returns success status and error message if applicable.
 */
export async function changeModelContext(
  baseUrl: string,
  apiKey: string | undefined,
  modelName: string,
  newCtxSize: number,
): Promise<{ success: boolean; error?: string }> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json",
  };
  if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;

  try {
    // Step 1: Unload the model
    const unloadRes = await fetch(`${baseUrl}/api/v1/unload`, {
      method: "POST",
      headers,
      body: JSON.stringify({ model_name: modelName }),
      signal: AbortSignal.timeout(10000),
    });

    if (!unloadRes.ok) {
      const err = await unloadRes.json().catch(() => ({}));
      const msg = (err as { error?: string }).error ?? unloadRes.statusText;
      return { success: false, error: `Unload failed: ${msg}` };
    }

    // Step 2: Reload with new ctx_size and save
    const reloadRes = await fetch(`${baseUrl}/api/v1/load`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model_name: modelName,
        ctx_size: newCtxSize,
        save_options: true,
      }),
      signal: AbortSignal.timeout(30000),
    });

    if (!reloadRes.ok) {
      const err = await reloadRes.json().catch(() => ({}));
      const msg = (err as { error?: string }).error ?? reloadRes.statusText;
      return { success: false, error: `Reload failed: ${msg}` };
    }

    return { success: true };
  } catch (e) {
    return { success: false, error: e instanceof Error ? e.message : String(e) };
  }
}
