import { Router, Request, Response } from 'express'
import { prisma } from '../lib/prisma'
import dayjs from 'dayjs'

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

  const conflict = await prisma.booking.findFirst({
    where: {
      memberId: booking.memberId,
      id: { not: id },
      status: { in: ['booked', 'checked_in'] },
      schedule: { date: newSchedule.date, startAt: newSchedule.startAt },
    },
    include: { schedule: true },
  })
  if (conflict) {
    return res.status(409).json({
      error: `该会员在 ${conflict.schedule.startAt} 时段已有预约，无法改期到同一时段`,
      conflictBookingId: conflict.id,
    })
  }

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

  const promoted = await tryPromoteWaitlist(booking.scheduleId)
  if (promoted) {
    console.log(`预约取消，候补会员 ${promoted.memberId} 进入待确认，候补ID=${promoted.waitlistId}`)
  }

  res.json({ data: updated, promotedWaitlist: !!promoted })
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

router.put('/:id/complete-with-feedback', async (req: Request, res: Response) => {
  const id = Number(req.params.id)
  const { rating, content } = req.body
  if (rating === undefined) return res.status(400).json({ error: 'rating 为必填' })
  if (rating < 1 || rating > 5) return res.status(400).json({ error: '评分范围 1-5' })

  const booking = await prisma.booking.findUnique({ where: { id } })
  if (!booking) return res.status(404).json({ error: '预约不存在' })
  if (booking.status !== 'booked' && booking.status !== 'checked_in')
    return res.status(400).json({ error: '仅已预约/已签到状态可提交上课结果' })

  const existingFeedback = await prisma.feedback.findUnique({ where: { bookingId: id } })
  if (existingFeedback) return res.status(409).json({ error: '该课程已提交反馈' })

  const result = await prisma.$transaction(async (tx) => {
    const updatedBooking = await tx.booking.update({
      where: { id },
      data: { status: 'completed' },
      include: { member: true, trainer: true, schedule: true, store: true },
    })
    const feedback = await tx.feedback.create({
      data: {
        bookingId: id,
        trainerId: booking.trainerId,
        memberId: booking.memberId,
        rating,
        content: content || null,
      },
    })
    return { booking: updatedBooking, feedback }
  })

  res.json({ data: result })
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

async function tryPromoteWaitlist(scheduleId: number): Promise<{ memberId: number; waitlistId: number } | null> {
  const schedule = await prisma.schedule.findUnique({ where: { id: scheduleId }, include: { trainer: true } })
  if (!schedule || schedule.isBooked) return null

  const currentPending = await prisma.waitlist.findFirst({
    where: { scheduleId, status: 'pending_confirm' },
  })
  if (currentPending) return null

  const waitingList = await prisma.waitlist.findMany({
    where: { scheduleId, status: 'waiting' },
    include: { memberPackage: true, member: true },
    orderBy: { priority: 'asc' },
  })

  const now = new Date()

  for (const w of waitingList) {
    const mp = w.memberPackage

    if (mp.remainSlots <= 0) {
      await prisma.waitlist.update({ where: { id: w.id }, data: { status: 'invalid' } })
      continue
    }
    if (mp.expireAt && mp.expireAt < schedule.date) {
      await prisma.waitlist.update({ where: { id: w.id }, data: { status: 'invalid' } })
      continue
    }
    if (mp.expireAt && mp.expireAt < now) {
      await prisma.waitlist.update({ where: { id: w.id }, data: { status: 'invalid' } })
      continue
    }

    const conflict = await prisma.booking.findFirst({
      where: {
        memberId: w.memberId,
        status: { in: ['booked', 'checked_in'] },
        schedule: { date: schedule.date, startAt: schedule.startAt },
      },
    })
    if (conflict) {
      await prisma.waitlist.update({ where: { id: w.id }, data: { status: 'invalid' } })
      continue
    }

    const confirmWindowMinutes = 30
    const expireAt = dayjs().add(confirmWindowMinutes, 'minute').toDate()

    await prisma.$transaction(async (tx) => {
      await tx.waitlist.update({
        where: { id: w.id },
        data: { status: 'pending_confirm', confirmExpireAt: expireAt, priority: 0 },
      })
      const rest = await tx.waitlist.findMany({
        where: { scheduleId, status: 'waiting', priority: { gt: w.priority } },
        orderBy: { priority: 'asc' },
      })
      for (const r of rest) {
        await tx.waitlist.update({ where: { id: r.id }, data: { priority: { decrement: 1 } } })
      }
    })

    await prisma.notification.create({
      data: {
        memberId: w.memberId,
        type: 'waitlist_promoted',
        title: '候补待确认',
        content: `您候补的 ${dayjs(schedule.date).format('MM-DD')} ${schedule.startAt}-${schedule.endAt} ${schedule.trainer.name} 教练课程有名额了！请在 ${confirmWindowMinutes} 分钟内确认，超时将让给其他候补会员`,
      },
    })

    return { memberId: w.memberId, waitlistId: w.id }
  }

  return null
}

router.post('/batch/noshow', async (req: Request, res: Response) => {
  const { bookingIds, reason, date, trainerId } = req.body as { bookingIds: number[]; reason?: string; date?: string; trainerId?: number }
  if (!Array.isArray(bookingIds) || bookingIds.length === 0)
    return res.status(400).json({ error: 'bookingIds 为必填数组' })

  const targetDate = date ? dayjs(date).startOf('day') : dayjs().startOf('day')
  const dayStart = targetDate.toDate()
  const dayEnd = targetDate.endOf('day').toDate()

  let successCount = 0
  const failed: { id: number; error: string }[] = []
  const skipped: { id: number; reason: string }[] = []

  for (const id of bookingIds) {
    try {
      const booking = await prisma.booking.findUnique({
        where: { id },
        include: { schedule: true },
      })
      if (!booking) {
        failed.push({ id, error: '预约不存在' })
        continue
      }
      if (trainerId && booking.trainerId !== Number(trainerId)) {
        skipped.push({ id, reason: '预约不属于当前教练' })
        continue
      }
      const scheduleDate = dayjs(booking.schedule.date).startOf('day')
      if (!scheduleDate.isSame(targetDate, 'day')) {
        skipped.push({ id, reason: `预约日期(${dayjs(booking.schedule.date).format('YYYY-MM-DD')})不在目标日期范围内` })
        continue
      }
      if (booking.status === 'checked_in' || booking.status === 'completed') {
        skipped.push({ id, reason: `预约已${booking.status === 'checked_in' ? '签到' : '完成'}，不标记爽约` })
        continue
      }
      if (booking.status === 'cancelled') {
        skipped.push({ id, reason: '预约已取消' })
        continue
      }
      if (booking.status === 'no_show') {
        skipped.push({ id, reason: '已标记爽约' })
        continue
      }
      if (booking.status !== 'booked') {
        failed.push({ id, error: '仅已预约状态可标记爽约' })
        continue
      }

      await prisma.$transaction(async (tx) => {
        await tx.booking.update({ where: { id }, data: { status: 'no_show' } })
        await tx.noShow.create({
          data: { bookingId: id, memberId: booking.memberId, reason: reason || null },
        })
      })

      await prisma.notification.create({
        data: {
          memberId: booking.memberId,
          type: 'no_show',
          title: '爽约提醒',
          content: `您 ${dayjs(booking.schedule.date).format('MM-DD')} ${booking.schedule.startAt} 的课程未按时到店，课时不予返还`,
        },
      })

      successCount++
    } catch (e: any) {
      failed.push({ id, error: e.message || '处理失败' })
    }
  }

  res.json({
    data: {
      targetDate: targetDate.format('YYYY-MM-DD'),
      total: bookingIds.length,
      successCount,
      failed,
      skipped,
      skippedCount: skipped.length,
      failedCount: failed.length,
    },
  })
})

router.post('/batch/remind', async (req: Request, res: Response) => {
  const { bookingIds, date, trainerId } = req.body as { bookingIds: number[]; date?: string; trainerId?: number }
  if (!Array.isArray(bookingIds) || bookingIds.length === 0)
    return res.status(400).json({ error: 'bookingIds 为必填数组' })

  const targetDate = date ? dayjs(date).startOf('day') : dayjs().startOf('day')

  let successCount = 0
  const failed: { id: number; error: string }[] = []
  const skipped: { id: number; reason: string }[] = []

  for (const id of bookingIds) {
    try {
      const booking = await prisma.booking.findUnique({
        where: { id },
        include: { schedule: true, trainer: true },
      })
      if (!booking) {
        failed.push({ id, error: '预约不存在' })
        continue
      }
      if (trainerId && booking.trainerId !== Number(trainerId)) {
        skipped.push({ id, reason: '预约不属于当前教练' })
        continue
      }
      const scheduleDate = dayjs(booking.schedule.date).startOf('day')
      if (!scheduleDate.isSame(targetDate, 'day')) {
        skipped.push({ id, reason: `预约日期(${dayjs(booking.schedule.date).format('YYYY-MM-DD')})不在目标日期范围内` })
        continue
      }
      if (booking.status === 'checked_in' || booking.status === 'completed') {
        skipped.push({ id, reason: `预约已${booking.status === 'checked_in' ? '签到' : '完成'}，无需提醒` })
        continue
      }
      if (booking.status === 'cancelled') {
        skipped.push({ id, reason: '预约已取消' })
        continue
      }
      if (booking.status === 'no_show') {
        skipped.push({ id, reason: '已标记爽约' })
        continue
      }
      if (booking.status !== 'booked') {
        failed.push({ id, error: '仅已预约状态可补发提醒' })
        continue
      }

      await prisma.notification.create({
        data: {
          memberId: booking.memberId,
          type: 'booking_reminder',
          title: '课程提醒',
          content: `提醒：您今日 ${booking.schedule.startAt} 有 ${booking.trainer.name} 教练的课程，请准时到店`,
        },
      })

      successCount++
    } catch (e: any) {
      failed.push({ id, error: e.message || '处理失败' })
    }
  }

  res.json({
    data: {
      targetDate: targetDate.format('YYYY-MM-DD'),
      total: bookingIds.length,
      successCount,
      failed,
      skipped,
      skippedCount: skipped.length,
      failedCount: failed.length,
    },
  })
})

export default router
