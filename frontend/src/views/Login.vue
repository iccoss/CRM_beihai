<template>
  <div class="login-container">
    <div class="login-bg-pattern"></div>
    <el-card class="login-card" shadow="always">
      <div class="login-header">
        <img src="/logo.svg" alt="贝海" class="login-logo" />
        <h1 class="login-title">贝海 CRM</h1>
        <p class="login-subtitle">客户关系管理系统</p>
      </div>

      <el-form :model="form" :rules="rules" ref="loginFormRef" class="login-form">
        <el-form-item prop="username">
          <el-input
            v-model="form.username"
            placeholder="请输入用户名"
            prefix-icon="User"
            size="large"
          />
        </el-form-item>
        <el-form-item prop="password">
          <el-input
            v-model="form.password"
            type="password"
            placeholder="请输入密码"
            prefix-icon="Lock"
            size="large"
            show-password
            @keyup.enter="handleLogin"
          />
        </el-form-item>
        <el-form-item>
          <el-button
            type="primary"
            size="large"
            :loading="loading"
            @click="handleLogin"
            class="login-btn"
          >
            登录
          </el-button>
        </el-form-item>
      </el-form>
    </el-card>
  </div>
</template>

<script setup>
import { ref, reactive } from 'vue'
import { useRouter } from 'vue-router'
import { ElMessage } from 'element-plus'
import axios from 'axios'

const router = useRouter()
const loginFormRef = ref(null)
const loading = ref(false)

const form = reactive({
  username: '',
  password: ''
})

const rules = {
  username: [{ required: true, message: '请输入用户名', trigger: 'blur' }],
  password: [{ required: true, message: '请输入密码', trigger: 'blur' }]
}

const handleLogin = async () => {
  if (!loginFormRef.value) return
  
  await loginFormRef.value.validate(async (valid) => {
    if (!valid) return
    
    loading.value = true
    try {
      const { data } = await axios.post('/api/auth/login', form)
      localStorage.setItem('token', data.token)
      localStorage.setItem('user', JSON.stringify(data.user))
      ElMessage.success('登录成功')
      router.push('/')
    } catch (error) {
      ElMessage.error(error.response?.data?.error || '登录失败')
    } finally {
      loading.value = false
    }
  })
}
</script>

<style scoped>
.login-container {
  display: flex;
  justify-content: center;
  align-items: center;
  min-height: 100vh;
  background: var(--color-bg-page);
  position: relative;
  overflow: hidden;
}

.login-bg-pattern {
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  background-image:
    radial-gradient(circle at 20% 20%, rgba(51, 112, 255, 0.06) 0%, transparent 40%),
    radial-gradient(circle at 80% 80%, rgba(51, 112, 255, 0.05) 0%, transparent 40%);
  pointer-events: none;
}

.login-card {
  width: 400px;
  border-radius: var(--radius-xl);
  border: 1px solid var(--color-border-light);
  box-shadow: 0 8px 32px rgba(31, 35, 41, 0.08);
  position: relative;
  z-index: 1;
}

.login-card :deep(.el-card__body) {
  padding: var(--spacing-3xl) var(--spacing-3xl) var(--spacing-2xl);
}

.login-header {
  text-align: center;
  margin-bottom: var(--spacing-2xl);
}

.login-logo {
  width: 56px;
  height: 56px;
  border-radius: var(--radius-lg);
  margin: 0 auto var(--spacing-lg);
  box-shadow: 0 4px 12px rgba(41, 85, 231, 0.25);
  display: block;
}

.login-title {
  font-size: 22px;
  font-weight: 700;
  color: var(--color-text-primary);
  margin: 0 0 var(--spacing-xs);
  letter-spacing: 0.5px;
}

.login-subtitle {
  font-size: 13px;
  color: var(--color-text-secondary);
  margin: 0;
}

.login-form {
  margin-top: var(--spacing-xl);
}

.login-form .el-form-item {
  margin-bottom: var(--spacing-lg);
}

.login-btn {
  width: 100%;
  height: 44px;
  font-size: 15px;
  font-weight: 600;
  border-radius: var(--radius-md);
  margin-top: var(--spacing-sm);
}
</style>
