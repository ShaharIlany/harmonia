// `import x from "./file.md" with { type: "file" }` gives the path of the embedded file, as a string.
// Bun's own types don't know this, so each extension we embed is declared here. (.html is left out:
// Bun's types already claim it as a bundle, so server.ts converts that one by hand.)
declare module "*.md" {
  const path: string;
  export default path;
}
declare module "*.css" {
  const path: string;
  export default path;
}
declare module "*.js" {
  const path: string;
  export default path;
}
declare module "*.json" {
  const path: string;
  export default path;
}
