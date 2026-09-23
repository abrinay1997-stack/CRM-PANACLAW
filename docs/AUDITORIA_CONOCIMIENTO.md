# Auditoría: lo que llega por GitHub contra lo que se carga desde el panel

> Pregunta (23-sep-2026): *lo que se mergea en GitHub y se despliega es el ADN
> del CRM, pero el CRM también tiene funciones de conocimiento en el panel.
> ¿Pueden entrar en conflicto? ¿Cuál funciona mejor? ¿Hacen lo mismo?*
>
> La auditoría en vivo se hizo en **Baby Caleb** (su D1, por el MCP de
> Cloudflare) y encontró los conflictos que se describen abajo. PanaClaw corre el
> mismo código de panel, así que tenía los mismos agujeros; los arreglos se
> portaron aquí. **La base de PanaClaw no se pudo mirar en vivo desde esa sesión**
> (el MCP estaba conectado a la cuenta de Baby Caleb): la lista del §4 es lo que
> conviene revisar a mano.

---

## 1. Las puertas y lo que cada una alimenta

En PanaClaw hay una puerta más que en Baby Caleb: **la web es el cerebro**
(`docs/cerebro-web.md`).

| Capa | Puerta GitHub | Puerta panel (D1) | ¿Cuál gana? |
|---|---|---|---|
| Base de conocimiento (`searchKb`) | `panaclaw.com/kb.json` → `pnpm kb:sync` → `member/kb/` → reindex | `/admin/kb` → `kb_docs` → **el mismo índice** | Conviven: el bot puede leer las dos. |
| Contexto del negocio (va en el prompt) | `member/config.local.ts` | Config → `business_context` | **El panel**, si tiene algo. |
| Prompt entero | el generado | `system_prompt_override` | **El panel**, y reemplaza TODO. |
| Reglas extra | — | `custom_instructions` (nuevo) | Se suman. No compiten. |
| Lecciones | — | flywheel → `learned_lessons` | Solo panel (con aprobación). |
| Enlaces autorizados | `member/config.local.ts` (siempre) | — | El repo, a propósito (ver `settings-loader.ts`). |

**La trampa:** lo que va *dentro del prompt* (contexto, override, lecciones) el
modelo lo lee antes de decidir si busca en la base. Un dato viejo en el panel le
gana al sitio y al repo sin que nada falle.

## 2. Lo que se encontró en Baby Caleb y se arregló también aquí

- **Config → "Instrucciones personalizadas" escribía `system_prompt_override`**,
  que reemplaza el prompt entero. Allá una línea dejó al bot sin fuentes ni
  contexto. Ahora el campo se llama *Instrucciones adicionales*, escribe
  `custom_instructions` y **se suma**. Si hay un override guardado, Config lo
  muestra en rojo con *Convertirlo* o *Borrarlo*.
- **La copia congelada del contexto.** Config pre-llena "Información del
  negocio" con la del repo; guardar la página la congelaba en D1 y desde ahí
  los cambios del repo no llegaban. Ahora una copia igual al repo se guarda vacía.
- **El tono pisado** por la primera tarjeta al guardar: ahora un tono propio se
  conserva (*Personalizado*) y se puede escribir a mano.
- **Una contraseña autocompletada como llave de IA.** El campo ya no se
  autocompleta, el formulario rechaza algo que no parece llave y el bot ignora
  una llave guardada que no lo es.
- **El analista nocturno** ya no memoriza precios en los datos de cada cliente.

## 3. ¿Cuál funciona mejor?

Para la base de conocimiento **hacen lo mismo técnicamente** (mismo índice),
pero no valen lo mismo:

- **El sitio y el repo son el dueño de lo permanente.** Quedan en git, con diff y
  con `git revert`. En PanaClaw además la verdad nace en `panaclaw.com`: se
  cambia allá y se sincroniza.
- **El panel es para lo urgente.** Lo que se escribe en `/admin/kb` no está en
  git, nadie ve el diff y convive con lo sincronizado: si algo es permanente, va
  al sitio.
- **El contexto del panel, vacío** salvo una urgencia.

## 4. Qué revisar en el panel de PanaClaw (5 minutos)

1. **Config**: ¿aparece el aviso rojo de prompt personalizado? Si sí,
   *Convertirlo* o *Borrarlo*.
2. **Config → Información del negocio**: si es igual a la del repo, guardar la
   página una vez la deja vacía (usa la del repo desde entonces).
3. **Config → Modelo de IA**: si dice que hay una key guardada y no la pusiste
   tú, *Quitar mi API key*.
4. **KB**: ¿hay documentos escritos desde el panel? Si dicen algo permanente,
   llevarlo a `panaclaw.com` y borrarlos del panel.
5. **Mejoras**: revisar lecciones pendientes antes de aprobarlas — en Baby Caleb
   una contradecía la regla de no mandar al cliente a otro canal.
