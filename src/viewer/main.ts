import { mount } from 'svelte'
import { type PublicDoc, PublicDocSchema } from '../lib/publish'
import App from './App.svelte'
import '../app.css'

let props: { doc?: PublicDoc; error?: string }
try {
  const content = document.getElementById('tylan-data')?.textContent ?? ''
  props = { doc: PublicDocSchema.parse(JSON.parse(content)) }
} catch {
  props = {
    error:
      'データ形式または参照が不正です。元の正本JSONを編集ツールで確認し、閲覧HTMLを再生成してください。',
  }
}
mount(App, { target: document.getElementById('app')!, props })
