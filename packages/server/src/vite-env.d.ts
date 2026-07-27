/* The sing pipeline lives in the app package and reads Vite's import.meta.env
 * for model base URLs. The server package has no Vite, so declare just that
 * shape: at runtime under node the values are simply undefined and the code's
 * documented defaults apply. */
interface ImportMetaEnv {
  readonly [key: string]: string | boolean | undefined
}
interface ImportMeta {
  readonly env: ImportMetaEnv
}
