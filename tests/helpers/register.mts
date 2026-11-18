import { register } from "node:module"

register(new URL("./ts-loader.mts", import.meta.url).href)
