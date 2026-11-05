import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type { Plugin } from 'vite'
export function viewerTemplatePlugin(): Plugin {
  return {
    name: 'tylan-viewer-template',
    resolveId(id) {
      if (id === 'virtual:viewer-template') {
        return `\0${id}`
      }
    },
    load(id) {
      if (id !== '\0virtual:viewer-template') {
        return
      }
      const path = resolve('.build/viewer/viewer-template.html')
      return `export default ${JSON.stringify(existsSync(path) ? readFileSync(path, 'utf8') : '')}`
    },
  }
}
export function standalonePlugin(mode: string): Plugin {
  return {
    name: 'tylan-standalone',
    enforce: 'post',
    generateBundle: {
      order: 'post',
      handler(_, bundle) {
        const htmlEntry = Object.values(bundle).find(
          (b) => b.type === 'asset' && b.fileName.endsWith('.html'),
        )
        if (htmlEntry?.type !== 'asset') {
          throw new Error('HTML entry is missing')
        }
        let html = String(htmlEntry.source)
        if (mode === 'viewer') {
          html = html.replace('"__TYLAN_DATA__"', '/*TYLAN_DATA*/')
        }
        const scripts: string[] = []
        html = html.replace(/<script\b[^>]*\bsrc="([^"]+)"[^>]*><\/script>/g, (_, src: string) => {
          const name = src.replace(/^\.\//, '').replace(/^\//, '')
          const chunk = bundle[name]
          if (chunk?.type !== 'chunk') {
            throw new Error(`Missing script: ${src}`)
          }
          const code = chunk.code.replace(/<\/script/gi, '<\\/script')
          scripts.push(code)
          return `<script type="module">${code}</script>`
        })
        html = html.replace(/<link\b[^>]*\bhref="([^"]+\.css)"[^>]*>/g, (_, href: string) => {
          const name = href.replace(/^\.\//, '').replace(/^\//, '')
          const css = bundle[name]
          if (css?.type !== 'asset') {
            throw new Error(`Missing CSS: ${href}`)
          }
          return `<style>${String(css.source)}</style>`
        })
        const hashes = scripts
          .map((code) => `'sha256-${createHash('sha256').update(code).digest('base64')}'`)
          .join(' ')
        const csp = `default-src 'none'; script-src ${hashes}; style-src 'unsafe-inline'; img-src data: blob:; connect-src 'none'; base-uri 'none'; form-action 'none'`
        html = html.replace(
          '<head>',
          `<head><meta http-equiv="Content-Security-Policy" content="${csp}">`,
        )
        if (
          !scripts.length ||
          /<(?:script|link)\b[^>]*(?:src|href)="(?!data:|#)/i.test(html) ||
          /\bimport\s*\(/.test(scripts.join(''))
        ) {
          throw new Error('Standalone output has external resources or dynamic imports')
        }
        for (const key of Object.keys(bundle)) {
          delete bundle[key]
        }
        const fileName = mode === 'viewer' ? 'viewer-template.html' : 'editor.html'
        this.emitFile({ type: 'asset', fileName, source: html })
      },
    },
  }
}
