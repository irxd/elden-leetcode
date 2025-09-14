import { defineConfig } from 'vite'

import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))

export default defineConfig({
    build: {
        minify: false,
        lib: {
            name: 'Elden Leetcode',
            entry: {
                background: resolve(__dirname, 'src/background.ts'),
                content: resolve(__dirname, 'src/content.ts')
            },
            formats: ['cjs'],
            fileName: (format, entryName) => `${entryName}.js`
        }
    }
})
