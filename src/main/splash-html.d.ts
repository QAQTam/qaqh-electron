/** esbuild `loader: { ".html": "text" }`(见 scripts/bundle.mjs)把 HTML 当字符串
 *  模块注入；这里只补 tsc 侧的模块形状。 */
declare module "*.html" {
  const content: string;
  export default content;
}
