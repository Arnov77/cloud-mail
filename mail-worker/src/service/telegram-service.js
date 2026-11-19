import orm from '../entity/orm';
import email from '../entity/email';
import settingService from './setting-service';
import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc';
import timezone from 'dayjs/plugin/timezone';
dayjs.extend(utc);
dayjs.extend(timezone);
import { eq } from 'drizzle-orm';
import jwtUtils from '../utils/jwt-utils';
import emailMsgTemplate from '../template/email-msg';
import emailTextTemplate from '../template/email-text';
import emailHtmlTemplate from '../template/email-html';
import domainUtils from "../utils/domain-uitls";
import proxyService from './proxy-service';

const telegramService = {

	async getEmailContent(c, params) {

		const { token } = params

		const result = await jwtUtils.verifyToken(c, token);

		if (!result) {
			return emailTextTemplate('Access denied')
		}

		const emailRow = await orm(c).select().from(email).where(eq(email.emailId, result.emailId)).get();

		if (emailRow) {

			if (emailRow.content) {
				// Telegram 网页预览：外链图改成 /proxy?url=，避免暴露打开者 IP。
				const html = await proxyService.rewriteHtml(c, emailRow.content);
				return emailHtmlTemplate(html || '')
			} else {
				return emailTextTemplate(emailRow.text || '')
			}

		} else {
			return emailTextTemplate('The email does not exist')
		}

	},

	async sendEmailToBot(c, email) {

		const { tgBotToken, tgChatId, tgThreadId, customDomain, tgMsgTo, tgMsgFrom, tgMsgText } = await settingService.query(c);

		const tgChatIds = tgChatId.split(',');
		// ID topik forum Telegram (0 = kirim ke chat utama, perilaku lama).
		const threadId = Number(tgThreadId) || 0;

		const jwtToken = await jwtUtils.generateToken(c, { emailId: email.emailId })

		const webAppUrl = customDomain ? `${domainUtils.toOssDomain(customDomain)}/api/telegram/getEmail/${jwtToken}` : 'https://www.cloudflare.com/404'
		const inlineKeyboard = [
			[
				{
					text: 'View',
					web_app: { url: webAppUrl }
				}
			]
		];

		if (email.code) {
			inlineKeyboard.push([
				{
					text: email.code,
					copy_text: { text: email.code }
				}
			]);
		}

		await Promise.all(tgChatIds.map(async chatId => {
			// Bila threadId diisi, kirim ke topik forum; bila topik tidak
			// ditemukan (mis. topik dihapus), kirim ulang ke chat utama
			// supaya notifikasi tidak hilang.
			const sendOnce = (useThread) => {
				const body = {
					chat_id: chatId,
					parse_mode: 'HTML',
					text: emailMsgTemplate(email, tgMsgTo, tgMsgFrom, tgMsgText),
					reply_markup: {
						inline_keyboard: inlineKeyboard
					}
				};
				if (useThread && threadId) {
					body.message_thread_id = threadId;
				}
				return fetch(`https://api.telegram.org/bot${tgBotToken}/sendMessage`, {
					method: 'POST',
					headers: {
						'Content-Type': 'application/json'
					},
					body: JSON.stringify(body)
				});
			};
			try {
				let res = await sendOnce(true);
				if (!res.ok && threadId) {
					console.error(`转发 Telegram 到话题失败 status: ${res.status} response: ${await res.text()}，重试到主聊天`);
					res = await sendOnce(false);
				}
				if (!res.ok) {
					console.error(`转发 Telegram 失败 status: ${res.status} response: ${await res.text()}`);
				}
			} catch (e) {
				console.error(`转发 Telegram 失败:`, e.message);
			}
		}));

	}

}

export default telegramService
