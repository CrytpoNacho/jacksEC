import { NextRequest, NextResponse } from "next/server";
import { generateInvoicePDF } from "../../../../lib/generateInvoice";
import { getServerSession } from "next-auth";
import { authOptions } from "../../../../lib/authOptions";
import { prisma } from "../../../../lib/prisma";
import nodemailer from "nodemailer";

// ✅ Configuración de Nodemailer
const transporter = nodemailer.createTransport({
  host: "smtp.office365.com",
  port: 587,
  secure: false,
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS,
  },
  tls: {
    ciphers: "SSLv3",
  },
});

// ✅ Enviar correo de confirmación
async function sendConfirmationEmail(email: string, nombre: string, transactionId: string, pdfFileName: string, total: number) {
  const fullPdfUrl = `${process.env.NEXT_PUBLIC_SITE_URL}/invoices/${pdfFileName}`;

  const mailOptions = {
    from: process.env.EMAIL_USER,
    to: email,
    subject: "Confirmación de compra - Jack's Ecommerce",
    html: `
      <h2>¡Gracias por tu compra, ${nombre}!</h2>
      <p>Tu pedido ha sido confirmado con éxito.</p>
      <p><strong>ID de la transacción:</strong> ${transactionId}</p>
      <p><strong>Total pagado:</strong> ₡${total.toFixed(2)}</p>
      <p>Puedes descargar tu factura desde el siguiente enlace:</p>
      <a href="${fullPdfUrl}" target="_blank">Descargar Factura</a>
      <p>Gracias por confiar en Jack's!</p>
    `,
  };

  try {
    await transporter.sendMail(mailOptions);
    console.log("✅ Correo de confirmación enviado a:", email);
  } catch (error) {
    console.error("❌ Error enviando correo:", error);
  }
}

export async function POST(req: NextRequest) {
  try {
    const session = await getServerSession(authOptions);
    if (!session || !session.user) {
      return NextResponse.json({ error: "No autorizado" }, { status: 401 });
    }

    const { cartItems, total } = await req.json();
    const transaction_id = `INV-${Math.random().toString(36).substr(2, 9)}`;
    const userId = Number(session.user.id);

    // ✅ Obtener datos del usuario
    const user = await prisma.usuarios_ecommerce.findUnique({
      where: { id: userId },
      select: { nombre: true, correo: true },
    });

    if (!user) {
      return NextResponse.json({ error: "Usuario no encontrado" }, { status: 404 });
    }

    // 📂 Generar la factura PDF
    const pdfUrl = await generateInvoicePDF(transaction_id, cartItems, total, user.nombre, userId, "Desconocido", "Online");

    // ✅ Extraer solo el nombre del archivo
    const pdfFileName = pdfUrl.split("/").pop() || "";

    // 📌 Evitar que supere el límite de la BD
    if (pdfFileName.length > 255) {
      return NextResponse.json({ error: "El nombre del archivo PDF es demasiado largo" }, { status: 500 });
    }

    // ✅ Guardar la compra en la base de datos
    const nuevaCompra = await prisma.historial_compras_ec.create({
      data: {
        id_usuario: userId,
        transaction_id,
        invoice: pdfFileName, // ⬅️ Guarda solo el nombre del archivo, no la URL
        fecha_hora: new Date(),
        device: "Desconocido",
        location: "Online",
        total,
        estado: "Pedido realizado",
        metodo_pago: "Deducción de Planilla",
      },
    });

    // 📌 Insertar productos comprados
    interface CartItem {
      id_producto: number;
      cantidad: number;
    }

    interface User {
      nombre: string;
      correo: string;
    }

    interface NuevaCompra {
      id: number;
    }

    await Promise.all(
      cartItems.map(async (item: CartItem) => {
        await prisma.productos_comprados.create({
          data: {
            id_historial: nuevaCompra.id,
            id_producto: item.id_producto,
            cantidad: item.cantidad,
          },
        });
      })
    );

    // ✅ Eliminar el carrito del usuario
    await prisma.carrito_ec.deleteMany({ where: { id_usuario: userId } });

    // ✅ Enviar Correo de Confirmación con la factura PDF
    await sendConfirmationEmail(user.correo, user.nombre, transaction_id, pdfFileName, total);

    return NextResponse.json({ transaction_id, pdfUrl }, { status: 200 });

  } catch (error) {
    console.error("❌ Error en el checkout:", error);
    return NextResponse.json({ error: "Error al procesar la compra" }, { status: 500 });
  }
}

