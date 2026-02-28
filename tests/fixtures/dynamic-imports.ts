export async function loadModule() {
  const mod = await import("./simple.js");
  return mod;
}
