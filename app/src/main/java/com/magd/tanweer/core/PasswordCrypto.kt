package com.magd.tanweer.core

import java.security.MessageDigest
import javax.crypto.Mac
import javax.crypto.spec.SecretKeySpec

/**
 * اشتقاق مفتاح الدخول على الجهاز — نفس عقد الخادم بالحرف:
 *
 *   1. الخادم يعيد `salt` من `/auth/kdf-params` (مشتق من pepper لا يصل إلى الجهاز).
 *   2. الجهاز يشتق `authKey = PBKDF2-HMAC-SHA256(password, salt, 210000, 32)` بصيغة hex.
 *   3. كلمة المرور نفسها **لا تُرسل ولا تُخزَّن** في أي مكان.
 *
 * PBKDF2 مكتوب يدويًا لأن `PBKDF2WithHmacSHA256` غير متاح قبل API 26، ولأن
 * الرسالة تبقى مطابقة في كل إصدارات أندرويد 6.0 وما فوق.
 */
object PasswordCrypto {

    const val DEFAULT_ITERATIONS = 210_000
    const val DEFAULT_KEY_LENGTH = 32

    fun deriveAuthKey(
        password: String,
        saltHex: String,
        iterations: Int = DEFAULT_ITERATIONS,
        keyLength: Int = DEFAULT_KEY_LENGTH,
    ): String = bytesToHex(pbkdf2(password.toByteArray(Charsets.UTF_8), hexToBytes(saltHex), iterations, keyLength))

    internal fun pbkdf2(password: ByteArray, salt: ByteArray, iterations: Int, keyLength: Int): ByteArray {
        require(iterations > 0) { "iterations must be positive" }
        require(keyLength > 0) { "keyLength must be positive" }

        val mac = Mac.getInstance("HmacSHA256")
        mac.init(SecretKeySpec(password, "HmacSHA256"))
        val hLen = mac.macLength
        val blocks = (keyLength + hLen - 1) / hLen
        val output = ByteArray(blocks * hLen)

        val saltWithIndex = ByteArray(salt.size + 4)
        System.arraycopy(salt, 0, saltWithIndex, 0, salt.size)
        val u = ByteArray(hLen)

        for (block in 1..blocks) {
            saltWithIndex[salt.size] = ((block ushr 24) and 0xFF).toByte()
            saltWithIndex[salt.size + 1] = ((block ushr 16) and 0xFF).toByte()
            saltWithIndex[salt.size + 2] = ((block ushr 8) and 0xFF).toByte()
            saltWithIndex[salt.size + 3] = (block and 0xFF).toByte()

            mac.reset()
            mac.update(saltWithIndex)
            mac.doFinal(u, 0)
            val acc = u.copyOf()

            for (round in 2..iterations) {
                mac.reset()
                mac.update(u)
                mac.doFinal(u, 0)
                for (i in 0 until hLen) {
                    acc[i] = (acc[i].toInt() xor u[i].toInt()).toByte()
                }
            }
            System.arraycopy(acc, 0, output, (block - 1) * hLen, hLen)
        }

        return output.copyOf(keyLength)
    }

    /** بصمة الملف التي يستخدمها الخادم لمنع تكرار الصفحة نفسها. */
    fun sha256Hex(bytes: ByteArray): String {
        val digest = MessageDigest.getInstance("SHA-256").digest(bytes)
        return bytesToHex(digest)
    }

    fun hmacSha256(key: String, message: String): String {
        val mac = Mac.getInstance("HmacSHA256")
        mac.init(SecretKeySpec(key.toByteArray(Charsets.UTF_8), "HmacSHA256"))
        return bytesToHex(mac.doFinal(message.toByteArray(Charsets.UTF_8)))
    }

    fun bytesToHex(bytes: ByteArray): String {
        val out = CharArray(bytes.size * 2)
        val digits = "0123456789abcdef"
        for (i in bytes.indices) {
            val value = bytes[i].toInt() and 0xFF
            out[i * 2] = digits[value ushr 4]
            out[i * 2 + 1] = digits[value and 0x0F]
        }
        return String(out)
    }

    fun hexToBytes(hex: String): ByteArray {
        val clean = hex.trim()
        require(clean.length % 2 == 0) { "hex string must have an even length" }
        val out = ByteArray(clean.length / 2)
        for (i in out.indices) {
            val high = Character.digit(clean[i * 2], 16)
            val low = Character.digit(clean[i * 2 + 1], 16)
            require(high >= 0 && low >= 0) { "invalid hex string" }
            out[i] = ((high shl 4) or low).toByte()
        }
        return out
    }

    /** يوحّد رقم الهاتف كما يفعل الخادم: 9 أرقام تبدأ بـ7. */
    fun normalizePhone(raw: String): String {
        val digits = raw.filter { it.isDigit() }
        return when {
            digits.length > 9 -> digits.takeLast(9)
            else -> digits
        }
    }

    fun isValidPhone(raw: String): Boolean {
        val phone = normalizePhone(raw)
        return phone.length == 9 && phone[0] == '7' && phone.all { it.isDigit() }
    }
}
