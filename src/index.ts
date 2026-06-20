import express from 'express'
import { prisma } from './lib/prisma'
import { requestLogger, errorHandler } from './middleware'
import memberRoutes from './routes/member'
import scheduleRoutes from './routes/schedule'
import packageRoutes from './routes/package'
import storeRoutes from './routes/store'
import bookingRoutes from './routes/booking'
import feedbackRoutes from './routes/feedback'
import notificationRoutes from './routes/notification'
import statsRoutes from './routes/stats'

const app = express()
const PORT = process.env.PORT || 3000

app.use(express.json())
app.use(requestLogger)

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() })
})

app.use('/api/members', memberRoutes)
app.use('/api/schedules', scheduleRoutes)
app.use('/api/packages', packageRoutes)
app.use('/api/stores', storeRoutes)
app.use('/api/bookings', bookingRoutes)
app.use('/api/feedbacks', feedbackRoutes)
app.use('/api/notifications', notificationRoutes)
app.use('/api/stats', statsRoutes)

app.use(errorHandler)

const server = app.listen(PORT, () => {
  console.log(`健身房私教预约系统后端服务已启动: http://localhost:${PORT}`)
  console.log(`API 文档地址: http://localhost:${PORT}/health`)
})

process.on('SIGINT', async () => {
  console.log('正在关闭服务...')
  await prisma.$disconnect()
  server.close(() => {
    console.log('服务已停止')
    process.exit(0)
  })
})

export default app
