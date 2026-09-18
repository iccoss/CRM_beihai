<template>
  <div class="customer-tag-list">
    <el-card>
      <div class="toolbar">
        <el-button type="primary" @click="showAddDialog">
          <el-icon><Plus /></el-icon>
          新增标签
        </el-button>
      </div>

      <el-table
        :data="tableData"
        v-loading="loading"
        style="width: 100%"
      >
        <el-table-column prop="name" label="标签名称" min-width="150" />
        <el-table-column prop="color" label="颜色" width="100">
          <template #default="{ row }">
            <div 
              v-if="row.color" 
              :style="{ 
                width: '30px', 
                height: '30px', 
                backgroundColor: row.color, 
                borderRadius: '4px',
                border: '1px solid #dee0e3'
              }"
            ></div>
            <span v-else>-</span>
          </template>
        </el-table-column>
        <el-table-column prop="customer_count" label="关联客户数" width="120" align="center" />
        <el-table-column prop="notes" label="备注" min-width="200" show-overflow-tooltip />
        <el-table-column prop="creator_name" label="创建人" width="120" />
        <el-table-column prop="created_at" label="创建时间" width="160" />
        <el-table-column label="操作" width="200" fixed="right">
          <template #default="{ row }">
            <el-button text type="primary" @click.stop="editTag(row)" :disabled="isOperations" title="运营角色只读，无权操作">编辑</el-button>
            <el-button text type="danger" @click.stop="deleteTag(row)" :disabled="isOperations" title="运营角色只读，无权操作">删除</el-button>
          </template>
        </el-table-column>
      </el-table>
    </el-card>

    <!-- 新增/编辑标签对话框 -->
    <el-dialog
      v-model="dialogVisible"
      :title="isEdit ? '编辑标签' : '新增标签'"
      width="500px"
      :close-on-click-modal="false"
    >
      <el-form :model="tagForm" :rules="rules" ref="formRef" label-width="100px">
        <el-form-item label="标签名称" prop="name">
          <el-input v-model="tagForm.name" placeholder="请输入标签名称（必填，最多 20 字符）" maxlength="20" />
        </el-form-item>
        <el-form-item label="标签颜色">
          <el-color-picker v-model="tagForm.color" />
        </el-form-item>
        <el-form-item label="备注">
          <el-input 
            v-model="tagForm.notes" 
            type="textarea" 
            :rows="3"
            placeholder="请输入备注信息"
          />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="dialogVisible = false">取消</el-button>
        <el-button type="primary" @click="submitForm" :loading="submitting">确定</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup>
import { ref, reactive, onMounted } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import request from '@/utils/request'

const loading = ref(false)
const submitting = ref(false)
const dialogVisible = ref(false)
const isEdit = ref(false)
const formRef = ref(null)

const tableData = ref([])

const tagForm = reactive({
  id: '',
  name: '',
  color: '',
  notes: ''
})

const rules = {
  name: [
    { required: true, message: '请输入标签名称', trigger: 'blur' },
    { min: 1, max: 20, message: '标签名称长度在 1-20 个字符', trigger: 'blur' }
  ]
}

const loadData = async () => {
  loading.value = true
  try {
    const { data } = await request.get('/api/customer-tags/list')
    tableData.value = data.tags
  } catch (error) {
    ElMessage.error('加载标签列表失败')
  } finally {
    loading.value = false
  }
}

const showAddDialog = () => {
  isEdit.value = false
  Object.assign(tagForm, {
    id: '',
    name: '',
    color: '',
    notes: ''
  })
  dialogVisible.value = true
}

const editTag = (row) => {
  isEdit.value = true
  Object.assign(tagForm, {
    id: row.id,
    name: row.name,
    color: row.color || '',
    notes: row.notes || ''
  })
  dialogVisible.value = true
}

const submitForm = async () => {
  if (!formRef.value) return
  
  await formRef.value.validate(async (valid) => {
    if (!valid) {
      ElMessage.error('请检查表单填写是否完整')
      return
    }
    
    submitting.value = true
    try {
      if (isEdit.value) {
        await request.put(`/api/customer-tags/${tagForm.id}`, tagForm)
        ElMessage.success('更新成功')
      } else {
        await request.post('/api/customer-tags', tagForm)
        ElMessage.success('创建成功')
      }
      dialogVisible.value = false
      loadData()
    } catch (error) {
      const errorMsg = error.response?.data?.error || error.message || '操作失败'
      ElMessage.error(errorMsg)
    } finally {
      submitting.value = false
    }
  })
}

const deleteTag = (row) => {
  ElMessageBox.confirm(`确定要删除标签"${row.name}"吗？`, '提示', { type: 'warning' })
    .then(async () => {
      try {
        await request.delete(`/api/customer-tags/${row.id}`)
        ElMessage.success('删除成功')
        loadData()
      } catch (error) {
        const errorMsg = error.response?.data?.error || '删除失败'
        ElMessage.error(errorMsg)
      }
    })
    .catch(() => {})
}

onMounted(() => {
  loadData()
})
</script>

<style scoped>
.customer-tag-list {
  padding: 0;
}

.toolbar {
  display: flex;
  align-items: center;
  gap: var(--spacing-sm);
  margin-bottom: var(--spacing-lg);
}
</style>
