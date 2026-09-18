import axios from 'axios'
import { ElMessage } from 'element-plus'
import router from '@/router'

// 创建 axios 实例
const service = axios.create({
  baseURL: '', // 同域名，不需要配置
  timeout: 10000 // 请求超时时间
})

// 请求拦截器
service.interceptors.request.use(
  config => {
    // 从 localStorage 获取 token
    const token = localStorage.getItem('token')
    
    if (token) {
      // 添加 Authorization 头
      config.headers['Authorization'] = `Bearer ${token}`
    }
    
    return config
  },
  error => {
    console.error('请求错误:', error)
    return Promise.reject(error)
  }
)

// 响应拦截器
service.interceptors.response.use(
  response => {
    return response
  },
  error => {
    // 处理 401 错误（未授权）
    if (error.config?.silentError) {
      return Promise.reject(error)
    }

    if (error.response && error.response.status === 401) {
      ElMessage.error('登录已过期，请重新登录')
      
      // 清除本地 token
      localStorage.removeItem('token')
      localStorage.removeItem('user')
      
      // 跳转到登录页
      router.push('/login')
    } 
    // 处理 403 错误（禁止访问）—— 静默处理，不弹出提示
    else if (error.response && error.response.status === 403) {
      // 权限不足时静默，由调用方自行处理
    }
    // 处理 404 错误
    else if (error.response && error.response.status === 404) {
      ElMessage.error('请求的资源不存在')
    }
    // 处理 500 错误
    else if (error.response && error.response.status === 500) {
      ElMessage.error('服务器错误')
    }
    // 其他错误
    else {
      const message = error.response?.data?.error || error.message || '请求失败'
      ElMessage.error(message)
    }
    
    return Promise.reject(error)
  }
)

export default service
