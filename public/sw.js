/* Service worker del panel de PanaClaw: solo recibe avisos y los muestra.
   No guarda nada en caché: el panel siempre se pide fresco al servidor. */
self.addEventListener("install", function () {
  self.skipWaiting();
});
self.addEventListener("activate", function (e) {
  e.waitUntil(self.clients.claim());
});

self.addEventListener("push", function (event) {
  var datos = {};
  try {
    datos = event.data ? event.data.json() : {};
  } catch (e) {
    datos = { titulo: "PanaClaw", cuerpo: event.data ? event.data.text() : "" };
  }
  var opciones = {
    body: datos.cuerpo || "",
    icon: "/icon-192.png",
    badge: "/favicon-32.png",
    data: { url: datos.url || "/admin/conversations" },
  };
  if (datos.etiqueta) opciones.tag = datos.etiqueta;
  event.waitUntil(self.registration.showNotification(datos.titulo || "PanaClaw", opciones));
});

self.addEventListener("notificationclick", function (event) {
  event.notification.close();
  var destino = (event.notification.data && event.notification.data.url) || "/admin/conversations";
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then(function (ventanas) {
      for (var i = 0; i < ventanas.length; i++) {
        var v = ventanas[i];
        if ("focus" in v) {
          v.navigate(destino);
          return v.focus();
        }
      }
      return self.clients.openWindow(destino);
    }),
  );
});
