<script setup lang="ts">
// A Settings tab's Save, shown above and below it. It submits the tab's form,
// so the browser checks the fields' bounds first.
defineProps<{ busy: boolean; unsaved: boolean; invalid?: boolean }>()
</script>

<template>
  <div class="row">
    <span class="muted small grow">{{ unsaved ? 'Unsaved changes' : '' }}</span>
    <button type="submit" class="btn btn-primary" :disabled="busy || !unsaved || invalid">
      <span v-if="busy" class="spinner" />
      Save
    </button>
  </div>
</template>
