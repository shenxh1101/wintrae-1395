import { Router, Request, Response } from 'express'
import { prisma } from '../lib/prisma'

const router = Router()

router.post('/', async (req: Request, res: Response) => {
  const { memberId, scheduleId, memberPackageId } = req.body
  if (!memberId || !scheduleId || !memberPackageId)
    return res.status(400).json({ error: '缺少必填字段' })

  const schedule = await prisma.schedule.findUnique({ where: { id: scheduleId } })
  if (!schedule) return res.status(404).json({ error: '排班时段不存在' })
  if (schedule.isBooked) return res.status(409).json({ error: '该时段已被预约' })

  const mp = await prisma.memberPackage.findUnique({ where: { id: memberPackageId } })
  if (!mp) return res.status(404).json({ error: '课程包不存在' })
  if (mp.memberId !== memberId) return res.status(400).json({ error: '课程包不属于该会员' })
  if (mp.remainSlots <= 0) return res.status(400).json({ error: '课时余量不足' })
  if (mp.expireAt && mp.expireAt < new Date()) return res.status(400).json({ error: '课程包已过期' })

  const existing = await prisma.booking.findFirst({
    where: { memberId, status: 'booked', schedule: { date: schedule.date, startAt: schedule.startAt } },
  })
  if (existing) return res.status(409).json({ error: '该会员在同一时段已有预约' })

  const booking = await prisma.$transaction(async (tx) => {
    const updatedMp = await tx.memberPackage.update({
      where: { id: memberPackageId },
      data: { remainSlots: { decrement: 1 } },
    })
    if (updatedMp.remainSlots < 0) throw new Error('课时余量不足')

    await tx.schedule.update({ where: { id: scheduleId }, data: { isBooked: true } })

    return tx.booking.create({
      data: {
        memberId,
        trainerId: schedule.trainerId,
        storeId: schedule.storeId,
        scheduleId,
        memberPackageId,
        status: 'booked',
      },
      include: { member: true, trainer: true, store: true, schedule: true, memberPackage: { include: { package: true } } },
    })
  })

  await prisma.notification.create({
    data: {
      memberId,
      type: 'booking_created',
      title: '预约成功',
      content: `您已成功预约${booking.trainer.name}教练 ${schedule.startAt}-${schedule.endAt} 的课程`,
    },
  })

  res.status(201).json({ data: booking })
})

router.put('/:id/reschedule', async (req: Request, res: Response) => {
  const id = Number(req.params.id)
  const { newScheduleId } = req.body
  if (!newScheduleId) return res.status(400).json({ error: '缺少新时段ID' })

  const booking = await prisma.booking.findUnique({ where: { id } })
  if (!booking) return res.status(404).json({ error: '预约不存在' })
  if (booking.status !== 'booked') return res.status(400).json({ error: '仅已预约状态可改期' })

  const newSchedule = await prisma.schedule.findUnique({ where: { id: newScheduleId } })
  if (!newSchedule) return res.status(404).json({ error: '新时段不存在' })
  if (newSchedule.isBooked) return res.status(409).json({ error: '新时段已被预约' })

  const updated = await prisma.$transaction(async (tx) => {
    await tx.schedule.update({ where: { id: booking.scheduleId }, data: { isBooked: false } })
    await tx.schedule.update({ where: { id: newScheduleId }, data: { isBooked: true } })
    return tx.booking.update({
      where: { id },
      data: { scheduleId: newScheduleId, trainerId: newSchedule.trainerId, storeId: newSchedule.storeId, status: 'booked' },
      include: { member: true, trainer: true, schedule: true, store: true },
    })
  })

  await prisma.notification.create({
    data: {
      memberId: booking.memberId,
      type: 'booking_rescheduled',
      title: '预约改期',
      content: `您的预约已改期至 ${newSchedule.startAt}-${newSchedule.endAt}`,
    },
  })

  res.json({ data: updated })
})

router.put('/:id/cancel', async (req: Request, res: Response) => {
  const id = Number(req.params.id)
  const { cancelReason } = req.body

  const booking = await prisma.booking.findUnique({ where: { id } })
  if (!booking) return res.status(404).json({ error: '预约不存在' })
  if (booking.status !== 'booked') return res.status(400).json({ error: '仅已预约状态可取消' })

  const updated = await prisma.$transaction(async (tx) => {
    await tx.schedule.update({ where: { id: booking.scheduleId }, data: { isBooked: false } })
    await tx.memberPackage.update({ where: { id: booking.memberPackageId }, data: { remainSlots: { increment: 1 } } })
    return tx.booking.update({
      where: { id },
      data: { status: 'cancelled', cancelledAt: new Date(), cancelReason: cancelReason || null },
      include: { member: true, trainer: true, schedule: true },
    })
  })

  await prisma.notification.create({
    data: {
      memberId: booking.memberId,
      type: 'booking_cancelled',
      title: '预约已取消',
      content: `您 ${booking.cancelReason ? '（原因：' + booking.cancelReason + '）' : ''}的预约已取消，课时已返还`,
    },
  })

  res.json({ data: updated })
})

router.put('/:id/checkin', async (req: Request, res: Response) => {
  const id = Number(req.params.id)

  const booking = await prisma.booking.findUnique({ where: { id } })
  if (!booking) return res.status(404).json({ error: '预约不存在' })
  if (booking.status !== 'booked') return res.status(400).json({ error: '仅已预约状态可签到' })

  const updated = await prisma.booking.update({
    where: { id },
    data: { status: 'checked_in', checkedInAt: new Date() },
    include: { member: true, trainer: true, schedule: true },
  })

  await prisma.notification.create({
    data: {
      memberId: booking.memberId,
      type: 'check_in',
      title: '签到成功',
      content: '您已成功到店签到，祝训练愉快！',
    },
  })

  res.json({ data: updated })
})

router.put('/:id/complete', async (req: Request, res: Response) => {
  const id = Number(req.params.id)

  const booking = await prisma.booking.findUnique({ where: { id } })
  if (!booking) return res.status(404).json({ error: '预约不存在' })
  if (booking.status !== 'checked_in') return res.status(400).json({ error: '仅已签到状态可完成' })

  const updated = await prisma.booking.update({
    where: { id },
    data: { status: 'completed' },
    include: { member: true, trainer: true, schedule: true },
  })

  res.json({ data: updated })
})

router.put('/:id/noshow', async (req: Request, res: Response) => {
  const id = Number(req.params.id)
  const { reason } = req.body

  const booking = await prisma.booking.findUnique({ where: { id } })
  if (!booking) return res.status(404).json({ error: '预约不存在' })
  if (booking.status !== 'booked') return res.status(400).json({ error: '仅已预约状态可标记爽约' })

  const updated = await prisma.$transaction(async (tx) => {
    const b = await tx.booking.update({ where: { id }, data: { status: 'no_show' } })
    await tx.noShow.create({ data: { bookingId: id, memberId: booking.memberId, reason: reason || null } })
    return b
  })

  await prisma.notification.create({
    data: {
      memberId: booking.memberId,
      type: 'no_show',
      title: '爽约提醒',
      content: '您有一节课未按时到店，课时不予返还',
    },
  })

  res.json({ data: updated })
})

router.get('/member/:memberId', async (req: Request, res: Response) => {
  const memberId = Number(req.params.memberId)
  const { status } = req.query as Record<string, string>

  const where: any = { memberId }
  if (status) where.status = status

  const bookings = await prisma.booking.findMany({
    where,
    include: { trainer: true, store: true, schedule: true, memberPackage: { include: { package: true } } },
    orderBy: { createdAt: 'desc' },
  })
  res.json({ data: bookings })
})

export default router
