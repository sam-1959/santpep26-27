# Regla Firebase · Tir lliure JBF

Integra el bloc següent dins de les regles de Realtime Database existents. Permet llegir i modificar entrenaments desats, però no eliminar-los ni canviar-ne l'identificador.

```json
"freeThrowTrainings": {
  "season-26-27": {
    "JBF": {
      ".read": true,
      "$entryId": {
        ".write": "newData.hasChildren(['id', 'teamKey', 'trainingDate', 'players', 'createdAt']) && newData.child('id').val() === $entryId"
      }
    }
  }
}
```
