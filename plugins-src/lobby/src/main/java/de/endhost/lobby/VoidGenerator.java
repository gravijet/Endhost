package de.endhost.lobby;

import org.bukkit.block.Biome;
import org.bukkit.generator.BiomeProvider;
import org.bukkit.generator.ChunkGenerator;
import org.bukkit.generator.WorldInfo;

import java.util.List;
import java.util.Random;

/**
 * An empty (void) world generator for the hub: no terrain, no caves, no structures, no mobs —
 * nothing but the plaza {@link LobbyWorld} lays down by hand. A matching {@link BiomeProvider}
 * pins the whole world to plains so the sky and light are bright and clean rather than the
 * dim fog of the void biome.
 */
final class VoidGenerator extends ChunkGenerator {

    @Override public void generateNoise(WorldInfo w, Random r, int cx, int cz, ChunkData d) { }
    @Override public void generateSurface(WorldInfo w, Random r, int cx, int cz, ChunkData d) { }
    @Override public void generateBedrock(WorldInfo w, Random r, int cx, int cz, ChunkData d) { }
    @Override public void generateCaves(WorldInfo w, Random r, int cx, int cz, ChunkData d) { }

    @Override public boolean shouldGenerateNoise() { return false; }
    @Override public boolean shouldGenerateSurface() { return false; }
    @Override public boolean shouldGenerateCaves() { return false; }
    @Override public boolean shouldGenerateDecorations() { return false; }
    @Override public boolean shouldGenerateMobs() { return false; }
    @Override public boolean shouldGenerateStructures() { return false; }

    @Override
    public BiomeProvider getDefaultBiomeProvider(WorldInfo worldInfo) {
        return new BiomeProvider() {
            @Override public Biome getBiome(WorldInfo info, int x, int y, int z) { return Biome.PLAINS; }
            @Override public List<Biome> getBiomes(WorldInfo info) { return List.of(Biome.PLAINS); }
        };
    }
}
