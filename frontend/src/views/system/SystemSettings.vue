<template>
  <div class="system-settings">
    <el-card>
      <template #header>
        <div class="settings-header">
          <span>配置管理</span>
          <el-button type="primary" :loading="saving" @click="save">保存配置</el-button>
        </div>
      </template>

      <el-form
        ref="formRef"
        :model="form"
        :rules="rules"
        label-width="180px"
        v-loading="loading"
        class="settings-form"
      >
        <el-form-item label="公海自动释放" prop="public_recycle_days">
          <div class="setting-control">
            <el-input-number
              v-model="form.public_recycle_days"
              :min="1"
              :step="1"
              :precision="0"
              controls-position="right"
              style="width: 180px"
            />
            <span class="unit">天</span>
          </div>
        </el-form-item>
        <el-alert
          type="info"
          :closable="false"
          show-icon
          title="私有客户连续自然日无跟进达到配置天数后，系统会自动释放为公海客户。"
        />
      </el-form>
    </el-card>
  </div>
</template>

<script setup>
import { reactive, ref, onMounted } from 'vue'
import { ElMessage } from 'element-plus'
import request from '@/utils/request'

const loading = ref(false)
const saving = ref(false)
const formRef = ref(null)
const form = reactive({
  public_recycle_days: 30
})

const rules = {
  public_recycle_days: [
    { required: true, message: '请输入自动释放天数', trigger: 'blur' },
    {
      validator: (rule, value, callback) => {
        if (!Number.isInteger(value) || value < 1) {
          callback(new Error('自动释放天数最少为 1 天'))
        } else {
          callback()
        }
      },
      trigger: 'change'
    }
  ]
}

const load = async () => {
  loading.value = true
  try {
    const { data } = await request.get('/api/settings', { silentError: true })
    const recycleSetting = (data.data || []).find(item => item.key === 'public_recycle_days')
    form.public_recycle_days = Math.max(1, Number.parseInt(recycleSetting?.value || '30', 10))
  } catch (error) {
    if (error.response?.status === 404) {
      ElMessage.error('配置接口不存在，请重启后端服务后再试')
    } else {
      ElMessage.error(error.response?.data?.error || '加载系统配置失败')
    }
  } finally {
    loading.value = false
  }
}

const save = async () => {
  if (!formRef.value) return
  await formRef.value.validate()
  saving.value = true
  try {
    await request.put('/api/settings/public-recycle-days', {
      value: form.public_recycle_days
    }, { silentError: true })
    ElMessage.success('配置已保存')
  } catch (error) {
    if (error.response?.status === 404) {
      ElMessage.error('配置接口不存在，请重启后端服务后再试')
    } else {
      ElMessage.error(error.response?.data?.error || '保存系统配置失败')
    }
  } finally {
    saving.value = false
  }
}

onMounted(load)
</script>

<style scoped>
.system-settings {
  padding: 20px;
}

.settings-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  font-weight: 600;
}

.settings-form {
  max-width: 720px;
}

.setting-control {
  display: flex;
  align-items: center;
  gap: 10px;
}

.unit {
  color: #646a73;
}
</style>
