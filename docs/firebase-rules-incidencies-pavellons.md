# Regla Firebase per a les incidències de pavellons

Afegiu el contingut de `firebase-rules-incidencies-pavellons.json` dins de l'objecte `rules` existent de Firebase Realtime Database; no substituïu la resta de regles.

La lectura s'ha de declarar a `entries` (i no dins de `$entryId`), perquè la pàgina consulta la llista sencera. La regla permet que qualsevol persona creï i consulti incidències. No permet modificar-les ni eliminar-les.
