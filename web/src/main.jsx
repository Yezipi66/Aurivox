// React 应用入口：把 App 挂到 index.html 里的 #root 元素上。
// root 元素由 index.html 预先留出，这里只负责挂载，界面逻辑都在 App 里。
import { createRoot } from 'react-dom/client'
import App from './App.jsx'

createRoot(document.getElementById('root')).render(<App />)
