<!-- app.vue -->
<script setup lang="ts">
// ssr
const message = await hi();
const layerMessage = await fromLayer();
// csr
const randoMessage = await randoHi();
const sharedRandoMessage = await sharedRandoHi();

const clientSideMessage = ref("");
async function loadClientSideMessage() {
  clientSideMessage.value = "Client-side message: " + (await hi());
}
</script>

<template>
  <div>
    <h1>Nuxt Workers Playground</h1>
    <div class="rows">
      <div class="row">
        <div class="label">hi():</div>
        <div class="value">{{ message }}</div>
      </div>
      <div class="row">
        <div class="label">fromLayer():</div>
        <div class="value">{{ layerMessage }}</div>
      </div>
      <div class="row">
        <div class="label">randoHi():</div>
        <div class="value">
          <ClientOnly>{{ randoMessage }}</ClientOnly>
        </div>
      </div>
      <div class="row">
        <div class="label">
          <button @click="loadClientSideMessage">
            Load client side message
          </button>
        </div>
        <div class="value">{{ clientSideMessage }}</div>
      </div>
      <div class="row">
        <div class="label">sharedRandoHi():</div>
        <div class="value">
          <ClientOnly>{{ sharedRandoMessage }}</ClientOnly>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.rows {
  display: flex;
  flex-direction: column;
}

.row {
  display: flex;
}

.row > div {
  flex: 1;
}

.label {
  text-align: right;
  padding-right: 20px;
}
</style>
